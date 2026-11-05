// 开播提醒云函数（定时触发器驱动）
//
// 取代本机 scripts/watch-live.js 的「必须开机」限制：
// - 每分钟由云开发定时触发器唤起（见 config.json triggers）
// - 跨用户读取云数据库 follows 集合（巡检的本职就是所有用户）
// - 状态查询复用 getStreamerStatus（云函数间调用，它自带 25s 缓存）
// - 判定复用 _shared/watch-rules（与本机脚本同一套规则）
// - 推送走微信订阅消息（一次性订阅：用户在小程序里点过「允许」才有额度）
// - 连续失败达到阈值发故障告警，避免「抖音改版后静默失效」的最坏情况
//
// 状态与失败计数持久化在云数据库 watchState 集合（云函数实例可能被回收，
// 不能像本机脚本那样用进程内文件）。
//
// 部署：
//   微信开发者工具 → cloudfunctions/watchLive → 右键「上传并部署：云端安装依赖」
//   → 再右键该函数 → 「上传触发器」（首次部署必须做一次，否则 cron 不生效）
const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { evaluate } = require('./_shared/watch-rules')
const { buildSubsData, buildAlertData } = require('./_shared/notify-data')
const { decideCooldownMinutes } = require('./_shared/pacing')
const { commitEvent } = require('./_shared/quota-ledger')

const FOLLOW_COLLECTION = 'follows'
const STATE_COLLECTION = 'watchState'
/** 订阅额度账本集合（docId = openid，一人一档） */
const QUOTA_COLLECTION = 'subsQuota'
const PAGE_SIZE = 100
// 自监控元数据文档（与用户状态同集合，docId 加 meta 前缀区分）：
// - PACING：下一轮是否跳过 + 每轮必写（哪怕跳轮），是定时器存活心跳
// - METRICS：最近一轮巡检的摘要与耗时，运行时调优的观测面
const PACING_DOC = 'meta__pacing'
const METRICS_DOC = 'meta__metrics'

// 新环境兜底：集合缺失时自建（管理端 SDK），部署即可用
const { ensureCollection } = require('./_shared/ensure-collection')

/** 连续失败多少轮后发一次故障告警 */
const FAIL_ALERT_THRESHOLD = 3
/** 告警冷却：两次故障告警之间至少间隔的时间 */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

/** 运行配置：模板 ID / 跳转路径 / 模板字段映射（获得模板后填 watch-config.json） */
function loadWatchConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'watch-config.json'), 'utf8'))
  } catch (e) {
    console.warn('[watchLive] watch-config.json 读取失败，仅巡检不推送:', e.message)
    return {}
  }
}

// ────────────────────────── 数据读取 ──────────────────────────

/**
 * 拉取全部用户的关注记录。
 * 注意：这里刻意【不按 openid 过滤】——巡检服务的就是所有人；
 * 与 getUserFollows/toggleFollow 里「必须带 _openid」的防同户泄漏不冲突。
 */
async function listAllFollows() {
  const coll = db.collection(FOLLOW_COLLECTION)
  let total = 0
  try {
    total = (await coll.count()).total || 0
  } catch (e) {
    console.warn('[watchLive] count 失败，退化成单页:', e.message)
  }

  const pages = total > PAGE_SIZE ? Math.ceil(total / PAGE_SIZE) : 1
  const all = []
  for (let i = 0; i < pages; i++) {
    const res = await coll
      .orderBy('createdAt', 'asc')
      .skip(i * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
    const batch = res.data || []
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return all
}

/** 读一条 watchState 文档（不存在返回 null） */
async function getStateDoc(docId) {
  try {
    const res = await db.collection(STATE_COLLECTION).doc(docId).get()
    return res.data || null
  } catch (e) {
    // 云开发对不存在的 doc 会直接抛错，这里当作「没有状态」
    return null
  }
}

/** 幂等写一条 watchState 文档 */
async function putStateDoc(docId, patch) {
  const coll = db.collection(STATE_COLLECTION)
  // 注意：云开发 doc().update() 对不存在的文档是「静默成功」的空操作（不报错也不创建），
  // 不能靠「update 失败再 add」兜底新建，必须先读后写。
  try {
    const got = await coll.doc(docId).get()
    if (got && got.data && Object.keys(got.data).length) {
      await coll.doc(docId).update({ data: patch })
      return
    }
  } catch (e) {
    // 不存在（get 报错）→ 走 add 新建
  }
  try {
    await coll.add({ data: Object.assign({ _id: docId }, patch) })
  } catch (e) {
    // 并发首写竞态：可能已被同时创建，改走 update
    await coll.doc(docId).update({ data: patch })
  }
}

/** 删除一条 watchState 文档（失败静默，不阻断巡检） */
async function removeStateDoc(docId) {
  try {
    await db.collection(STATE_COLLECTION).doc(docId).remove()
  } catch (e) {
    // ignore
  }
}

// ────────────────────────── 状态查询 ──────────────────────────

/**
 * 通过云函数间调用复用 getStreamerStatus（含其 SSR 解析与 25s 缓存）。
 * 失败返回 { ok: false, error }，由调用方决定降级策略。
 */
async function queryStatus(uniqueId) {
  try {
    const res = await cloud.callFunction({
      name: 'getStreamerStatus',
      data: { uniqueId }
    })
    const result = res.result
    if (!result || result.code !== 0 || !result.data) {
      return { ok: false, error: (result && result.message) || '查询失败：无数据' }
    }
    return { ok: true, info: result.data }
  } catch (e) {
    return { ok: false, error: e.message || '查询失败：云函数调用异常' }
  }
}

// ────────────────────────── 订阅消息推送 ──────────────────────────

/**
 * 发一条订阅消息。
 * 一次性订阅的额度模型：用户每点一次「允许」攒一条额度，这里消费一条。
 * 常见失败码：
 *   43101 用户未订阅/额度不足（正常现象，不重试、不告警）
 *   200014 模板 ID 无效（配置错误，日志高亮）
 */
async function sendSubs(openid, templateId, page, data, miniprogramState) {
  if (!templateId) return { ok: false, errCode: 'CONFIG', errMsg: '模板 ID 未配置' }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page,
      data,
      miniprogramState
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, errCode: e.errCode || String(e), errMsg: e.errMsg || e.message }
  }
}

/** 订阅额度记账：推送成功扣 1 条（43101 表示平台侧已无额度 → 账本归零校准） */
async function recordQuotaEvent(openid, type) {
  try {
    await commitEvent(db, QUOTA_COLLECTION, openid, { type })
  } catch (e) {
    // 账本失败不影响推送主链路；显示层面宁虚低不虚高
    console.warn(`[watchLive] 额度记账失败 openid=${openid.slice(0, 6)}… type=${type}:`, e.message)
  }
}

/** 开播通知与故障告警共用：通知每个订阅者，汇总结果写日志 */
async function notifySubscribers(subscribers, templateId, page, data, miniprogramState, label) {
  let sent = 0
  const failures = []
  for (const openid of subscribers) {
    // 逐个发送，单人失败不阻断其他人
    const r = await sendSubs(openid, templateId, page, data, miniprogramState)
    if (r.ok) {
      sent += 1
      await recordQuotaEvent(openid, 'spend')
    } else if (r.errCode === 43101) {
      // 43101（没订阅额度）是常态不打进失败列表；顺带把账本校准到 0
      await recordQuotaEvent(openid, 'zero')
    } else {
      // 其他错误也不扣额度（平台没扣），进失败明细
      failures.push(`${openid.slice(0, 6)}…:${r.errCode}`)
    }
  }
  console.log(`[watchLive] ${label}: 尝试 ${subscribers.length} 人，成功 ${sent}，异常 ${failures.length}`)
  if (failures.length) console.warn('[watchLive] 推送异常明细:', failures.join('; '))
  return sent
}

// ────────────────────────── 主流程 ──────────────────────────

/** 一个主播的查询失败处理：累计计数并在阈值/冷却窗口内推告警 */
async function handleStreamFailure(uniqueId, subscribers, error, config) {
  const docId = `fail__${uniqueId}`
  const prev = (await getStateDoc(docId)) || {}
  const failCount = (prev.failCount || 0) + 1
  const failedAt = Date.now()
  const lastAlertAt = prev.lastAlertAt || 0

  await putStateDoc(docId, {
    uniqueId,
    failCount,
    lastError: String(error || '').slice(0, 200),
    failedAt
  })

  const shouldAlert =
    failCount === FAIL_ALERT_THRESHOLD ||
    (failCount > FAIL_ALERT_THRESHOLD && failedAt - lastAlertAt > ALERT_COOLDOWN_MS)
  if (!shouldAlert) return

  console.error(`[watchLive] ${uniqueId} 连续失败 ${failCount} 轮: ${error}`)
  const sent = await notifySubscribers(
    subscribers,
    config.alertTemplateId,
    config.page || 'pages/home/index',
    buildAlertData(
      { detail: `连续 ${failCount} 次查询失败：${String(error).slice(0, 60)}`, failedAt },
      config.alertKeys
    ),
    config.miniprogramState || 'formal',
    `故障告警 ${uniqueId}`
  )
  if (sent > 0) {
    // 有人收到了告警，拉长冷却，避免每轮轰炸
    await putStateDoc(docId, { lastAlertAt: failedAt })
  }
}

/** 一个主播的查询成功处理：清失败计数，逐用户判定 + 推送 */
async function handleStreamSuccess(uniqueId, subscribers, info, config) {
  await removeStateDoc(`fail__${uniqueId}`)

  let pushed = 0
  for (const openid of subscribers) {
    const docId = `${openid}__${uniqueId}`
    const prev = await getStateDoc(docId)
    const { next, notify } = evaluate(prev, info)
    await putStateDoc(docId, { openid, uniqueId, ...next })

    if (!notify) continue
    const page = (config.page || '').includes('{uniqueId}')
      ? (config.page || '').replace('{uniqueId}', uniqueId)
      : config.page || 'pages/home/index'
    const r = await sendSubs(
      openid,
      config.templateId,
      page,
      buildSubsData(info, config.keys),
      config.miniprogramState || 'formal'
    )
    if (r.ok) {
      pushed += 1
      await recordQuotaEvent(openid, 'spend')
    } else if (r.errCode === 'CONFIG' || r.errCode === 200014) {
      console.error(`[watchLive] 推送配置问题(${r.errCode})，后续用户跳过以防刷量`)
      break
    } else if (r.errCode === 43101) {
      // 平台确认没有额度：账本归零校准（防账本虚高）
      await recordQuotaEvent(openid, 'zero')
    } else {
      console.warn(`[watchLive] 推送失败 openid=${openid.slice(0, 6)}… err=${r.errCode} ${r.errMsg}`)
    }
  }
  return pushed
}

exports.main = async () => {
  const config = loadWatchConfig()
  const roundStartedAt = Date.now()
  try {
    // 集合兜底：follows / watchState 不存在则自建（首次部署后的第一轮会跑这里）
    await ensureCollection(db, FOLLOW_COLLECTION)
    await ensureCollection(db, STATE_COLLECTION)

    // ── 节奏门：冷却期内只刷新心跳不巡检，省 QPS ──
    // 注意：即使跳轮也必须写 PACING 文档——它是「定时器是否还活着」的心跳证据
    let pacing = null
    try {
      pacing = await getStateDoc(PACING_DOC)
    } catch (e) {
      pacing = null
    }
    if (pacing && Number(pacing.waitUntil) > roundStartedAt) {
      await putStateDoc(PACING_DOC, {
        lastRoundAt: roundStartedAt,
        waitUntil: pacing.waitUntil,
        mode: 'cooldown'
      })
      console.log(`[watchLive] 冷却期至 ${new Date(Number(pacing.waitUntil)).toISOString()}，本轮跳过`)
      return { code: 0, message: 'pacing-skip', pushed: 0 }
    }

    const follows = await listAllFollows()
    if (follows.length === 0) {
      // 空名单也进入冷却，空转每分钟查询集合没意义
      const cooldownMs = decideCooldownMinutes({ anyLiving: false, anyFailed: false }, config.pacing) * 60 * 1000
      await putStateDoc(PACING_DOC, {
        waitUntil: roundStartedAt + cooldownMs,
        lastRoundAt: roundStartedAt,
        mode: 'idle-empty'
      })
      console.log('[watchLive] 关注列表为空，本轮跳过')
      return { code: 0, message: 'empty', pushed: 0 }
    }

    // 同一主播多个用户关注：查询一次、状态各判各的。
    // 无主记录（_openid 缺失，坑 #9 同类）跳过——不生成 undefined__* 状态档，
    // 但计数上报（meta__orphans），系统自己把坏数据点亮而不是埋着
    const orphans = []
    const byStreamer = new Map()
    for (const f of follows) {
      const id = f && f.uniqueId
      if (!id) continue
      if (!f._openid) {
        orphans.push(id)
        continue
      }
      if (!byStreamer.has(id)) byStreamer.set(id, [])
      byStreamer.get(id).push(f._openid)
    }
    if (orphans.length > 0) {
      console.error(`[watchLive] 发现 ${orphans.length} 条无主关注（_openid 缺失，跳过巡检订阅）: ${orphans.join(', ')}`)
      await putStateDoc('meta__orphans', {
        count: orphans.length,
        uniqueIds: orphans,
        lastSeenAt: Date.now()
      })
    }

    let pushed = 0
    let failedStreams = 0
    let livingStreams = 0
    for (const [uniqueId, openids] of byStreamer) {
      const q = await queryStatus(uniqueId)
      if (!q.ok) {
        failedStreams += 1
        await handleStreamFailure(uniqueId, openids, q.error, config)
        continue
      }
      if (q.info && q.info.status === 'living') livingStreams += 1
      pushed += await handleStreamSuccess(uniqueId, openids, q.info, config)
    }

    console.log(
      `[watchLive] 本轮完成：主播 ${byStreamer.size} 个 / 用户记录 ${follows.length} 条，推送 ${pushed} 条`
    )

    // ── 自我调优：按本轮结果写下一轮冷却 + 落本轮指标 ──
    // 连败轮数计数：任何一轮没有失败就清零；持续失败时指数退避由 pacing 纯函数处理
    const prevStreak = Number(pacing && pacing.failStreak) > 0 ? Number(pacing.failStreak) : 0
    const failStreak = failedStreams > 0 ? prevStreak + 1 : 0
    const cooldownMinutes = decideCooldownMinutes(
      { anyLiving: livingStreams > 0, anyFailed: failedStreams > 0, failStreak },
      config.pacing
    )
    const mode = failedStreams > 0 ? 'fail-backoff' : (livingStreams > 0 ? 'active' : 'idle')
    await putStateDoc(PACING_DOC, {
      waitUntil: Date.now() + cooldownMinutes * 60 * 1000,
      lastRoundAt: Date.now(),
      mode,
      failStreak
    })
    await putStateDoc(METRICS_DOC, {
      startedAt: roundStartedAt,
      durationMs: Date.now() - roundStartedAt,
      streamers: byStreamer.size,
      records: follows.length,
      pushed,
      failedStreams,
      livingStreams,
      // 无主关注自检（坑 #9 同类）：>0 时需要人工介入重绑/清理
      orphans: orphans.length,
      mode,
      nextCooldownMinutes: cooldownMinutes
    })

    return { code: 0, message: 'success', pushed, mode, nextCooldownMinutes: cooldownMinutes, orphans: orphans.length }
  } catch (err) {
    console.error('[watchLive] 本轮异常:', err)
    // 定时触发场景下抛错会记录在云函数日志里，可被开发者工具看到
    // 异常轮也退避，避免抖音侧故障时每分钟白烧触发器调用
    try {
      // 连败轮数沿用顺延（异常轮计 +1，冷却计算沿用指数退避）
      const prevStreak = Number(pacing && pacing.failStreak) > 0 ? Number(pacing.failStreak) : 0
      const failStreak = prevStreak + 1
      const cooldownMs = decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak }, config.pacing) * 60 * 1000
      await putStateDoc(PACING_DOC, {
        waitUntil: Date.now() + cooldownMs,
        lastRoundAt: Date.now(),
        mode: 'error-backoff',
        failStreak
      })
    } catch (e) {
      // 状态写入失败不影响返回
    }
    return { code: -1, message: err.message || 'watchLive 异常' }
  }
}
