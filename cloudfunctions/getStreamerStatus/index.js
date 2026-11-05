// 抖音直播状态查询云函数（SSR 方案，无需签名）
// 原理：直播间页面 live.douyin.com/{抖音号} 的 HTML 内由服务端注水了 roomInfo，
//      其中 room.status: 2=直播中, 4=未开播
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const https = require('https')
const zlib = require('zlib')

// 主播 ID -> 抖音号(unique_id) 映射；抖音号即直播间地址 live.douyin.com/{unique_id}
const STREAMER_MAP = {
  '1': { uniqueId: '54681081079', name: '冻腰（三角洲行动）' }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const REDIRECT_CODES = [301, 302, 303, 307, 308]

/** 默认请求头 */
function buildHeaders(extra) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://live.douyin.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    ...extra
  }
}

/** 按 content-encoding 解压响应流 */
function decompress(res) {
  const encoding = res.headers['content-encoding']
  if (encoding === 'gzip') return res.pipe(zlib.createGunzip())
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress())
  if (encoding === 'deflate') return res.pipe(zlib.createInflate())
  return res
}

/** 把响应流读完，resolve 出 { statusCode, body, headers, setCookies } */
function readResponse(res) {
  return new Promise((resolve, reject) => {
    const stream = decompress(res)
    let data = ''
    stream.on('data', (chunk) => {
      data += chunk
    })
    stream.on('end', () =>
      resolve({
        statusCode: res.statusCode,
        body: data,
        headers: res.headers,
        setCookies: res.headers['set-cookie'] || []
      })
    )
    stream.on('error', reject)
  })
}

/** 重定向时合并 cookie 并递归请求 */
function followRedirect(url, options, res, headers) {
  const location = res.headers.location
  const redirectUrl = location.startsWith('http') ? location : new URL(url).origin + location
  const newCookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
  const existing = headers['Cookie'] || ''
  const cookie = existing ? `${existing}; ${newCookies}` : newCookies
  return httpRequest(redirectUrl, { ...options, headers: { ...headers, Cookie: cookie } })
}

/** 是否应当跟随重定向 */
function shouldFollow(res, options) {
  return REDIRECT_CODES.includes(res.statusCode) && res.headers.location && options.followRedirects !== 0
}

/**
 * HTTPS 请求（自动解压 gzip/deflate/br、跟随重定向并合并 cookie）
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const headers = buildHeaders(options.headers)

    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers
      },
      (res) => {
        if (shouldFollow(res, options)) {
          return resolve(followRedirect(url, options, res, headers))
        }
        readResponse(res).then(resolve, reject)
      }
    )

    req.on('error', reject)
    req.setTimeout(options.timeout || 12000, () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    req.end()
  })
}

function mergeCookies(setCookies) {
  return (setCookies || []).map(c => c.split(';')[0]).join('; ')
}

/**
 * 从 SSR HTML 中提取注水的转义 JSON 对象。
 * html 中的房间数据形如：\"roomInfo\":{\"room\":{\"id_str\":\"...\" ... }}（JS 字符串里的转义 JSON）
 * 通过括号配平截取对象，再做双重 JSON.parse 还原转义。
 */
function extractEscapedObject(html, marker) {
  const start = html.indexOf(marker)
  if (start === -1) return null
  const braceStart = html.indexOf('{', start)
  if (braceStart === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const raw = html.substring(braceStart, i + 1)
        try {
          // 第一步：把转义的 JS 字符串内容还原为纯 JSON 文本；第二步：解析为对象
          const jsonText = JSON.parse('"' + raw + '"')
          return JSON.parse(jsonText)
        } catch (e) {
          // 兜底：手工反转义
          const text = raw
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\\//g, '/')
            .replace(/\\u0026/g, '&')
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
          try { return JSON.parse(text) } catch (e2) { return null }
        }
      }
    }
  }
  return null
}

/**
 * 查询单个抖音号的直播状态
 */
async function queryByUniqueId(uniqueId) {
  // 1. 访问首页获取 ttwid 等基础 cookie
  let cookie = ''
  try {
    const home = await httpRequest('https://live.douyin.com/')
    cookie = mergeCookies(home.setCookies)
  } catch (e) {
    console.warn('[dy] 获取首页 cookie 失败（继续尝试）:', e.message)
  }

  // 2. 拉取直播间 SSR 页面
  const pageUrl = `https://live.douyin.com/${uniqueId}`
  const res = await httpRequest(pageUrl, { headers: { Cookie: cookie } })
  if (res.statusCode !== 200 || res.body.length < 10000) {
    throw new Error(`直播间页面异常: HTTP ${res.statusCode}, ${res.body.length} bytes`)
  }

  // 3. 提取注水的 roomInfo（页面中有两处 roomInfo，第一处是空的 Redux 初始状态，
  //    带 room.id_str 的才是真实数据）
  const roomInfo = extractEscapedObject(res.body, '\\"roomInfo\\":{\\"room\\":{\\"id_str\\"')
  if (!roomInfo || !roomInfo.room) {
    throw new Error('未解析到房间数据（主播可能不存在或页面结构变更）')
  }

  const room = roomInfo.room
  const anchor = roomInfo.anchor || {}
  const isLiving = room.status === 2

  const avatar = anchor.avatar_thumb && anchor.avatar_thumb.url_list
    ? anchor.avatar_thumb.url_list[0]
    : ''
  const cover = room.cover && room.cover.url_list ? room.cover.url_list[0] : ''
  const viewerCount = parseInt(room.user_count_str, 10) || 0
  const likeCount = parseInt(room.like_count, 10) || 0
  const startTime = room.create_time ? room.create_time * 1000 : (isLiving ? Date.now() : 0)

  return {
    uniqueId,
    webRid: roomInfo.web_rid || uniqueId,
    roomId: room.id_str || '',
    anchorId: anchor.id_str || '',
    secUid: anchor.sec_uid || '',
    nickname: anchor.nickname || '',
    avatar,
    status: isLiving ? 'living' : 'offline',
    roomStatus: room.status,
    roomTitle: room.title || '',
    viewerCount,
    likeCount,
    roomCover: cover,
    roomUrl: pageUrl,
    liveStartTime: startTime
  }
}

// 兼容多种调用入口：微信云函数直接传参、HTTP 网关（event.body / queryStringParameters）
const { parseParams } = require('./_shared/parseParams')

/**
 * 结果缓存：同一 uniqueId 在 TTL 内复用上次抓取结果。
 *
 * 为什么需要：
 * 每次查询要抓 2 个页面（首页拿 cookie + 直播间页），而前端有多个页面
 * 会查同一个主播。没有缓存时请求量会成倍放大，很容易触发抖音风控。
 *
 * 云函数实例在热启动期间复用同一进程，模块级 Map 可以跨调用生效；
 * 冷启动会清空，属于可接受的降级（只是少命中一次缓存）。
 */
const CACHE_TTL_MS = 25 * 1000
const CACHE_MAX_ENTRIES = 200
const resultCache = new Map()

function getCached(uniqueId) {
  const entry = resultCache.get(uniqueId)
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    resultCache.delete(uniqueId)
    return null
  }
  return entry.info
}

function setCached(uniqueId, info) {
  // 简单的容量控制，避免长期运行累积
  if (resultCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value
    if (oldest !== undefined) resultCache.delete(oldest)
  }
  resultCache.set(uniqueId, { info, at: Date.now() })
}

exports.main = async (event) => {
  try {
    const { streamerId, uniqueId: inputUniqueId } = parseParams(event, ['streamerId', 'uniqueId'])

    // 支持直接传入抖音号查询；否则按内置映射表查询
    let uniqueId = inputUniqueId
    let fallbackName = ''
    if (!uniqueId) {
      if (!streamerId) return { code: -1, message: '缺少 streamerId 或 uniqueId', data: null }
      const conf = STREAMER_MAP[streamerId]
      if (!conf) {
        return { code: 0, message: 'success', data: { streamerId, status: 'offline', source: 'none' } }
      }
      uniqueId = conf.uniqueId
      fallbackName = conf.name
    }

    const cached = getCached(uniqueId)
    const info = cached || (await queryByUniqueId(uniqueId))
    if (!cached) setCached(uniqueId, info)

    return {
      code: 0,
      message: 'success',
      data: {
        streamerId: streamerId || info.uniqueId,
        uniqueId: info.uniqueId,
        nickname: info.nickname || fallbackName,
        avatar: info.avatar,
        secUid: info.secUid,
        roomId: info.roomId,
        anchorId: info.anchorId,
        webRid: info.webRid,
        status: info.status,
        roomStatus: info.roomStatus,
        roomTitle: info.roomTitle || info.nickname || fallbackName,
        viewerCount: info.viewerCount,
        likeCount: info.likeCount,
        roomCover: info.roomCover,
        roomUrl: info.roomUrl,
        liveStartTime: info.liveStartTime,
        source: cached ? 'ssr-cache' : 'ssr'
      }
    }
  } catch (err) {
    console.error('[dy] getStreamerStatus error:', err)
    return { code: -1, message: err.message || '查询直播状态失败', data: null }
  }
}
