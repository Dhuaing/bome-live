// 守护自检云函数（AI / 系统自我维护层）
//
// 触发：每天 08:00 / 20:00 定时器（config.json triggers）。
// 职责：读 watchState 的三份自监测文档，发现异常分级处理——
//   L1 自动自愈：心跳长时间停摆（watchLive 定时触发器失联/冷启动失败）
//              → 直接补调一轮 watchLive，把巡检拉回正轨（自愈，无需人）
//   L2 自动上报：持续失败退避 / 无主关注 / 额度账本异常
//              → 落 meta__incidents 文档（AI 值守脚本直接读它接手）
//   L3 人_工干预：L2 的事项若重复出现超过 IN N 次，由 AI/人再介入排查
//
// results.py：
//   - 自愈动作返回 summary，写 meta__guardian 文档（最近一次自检快照）
// 设计注意：云函数权限最小化——不依赖外部 DNS/网络（wx-server-sdk 环境内自洽）
//
// 另一个入口：action:'clientError' —— 小程序前端未捕获异常的上报口。
// 为什么放在 guardian：它是「自我维护层」，前端崩溃正是需要维护的信号；
// 单独建一个云函数不值当，写进 watchState 的 cerr__<openid> 文档即可（无新集合）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const STATE_COLLECTION = 'watchState'
const INCIDENTS_DOC = 'meta__incidents'
const GUARDIAN_DOC = 'meta__guardian'

/** 认定心跳停摆的分钟阈值：watchLive 每分钟或最少 30 分钟冷却也该可见 */
const HEARTBEAT_STALE_MIN = 20
/** 事故文档最多保留条数 */
const MAX_INCIDENTS = 50

/** 前端上报字段上限（防大字符串撑爆文档） */
const CLIENT_ERROR_MAX = { message: 300, stack: 1500, page: 120, kind: 40 }
/** 同一用户两次上报的最小间隔：前端死循环报错会每分钟刷一次 */
const CLIENT_ERROR_THROTTLE_MS = 60 * 1000
/** 每个用户保留最近几条 */
const CLIENT_ERROR_KEEP = 5
/** 累计到这么多条就往 meta__incidents 记一条（提示 AI/人去看） */
const CLIENT_ERROR_REPORT_AT = 3
/** 前端上报文档前缀（cerr__<openid>） */
const CLIENT_ERROR_PREFIX = 'cerr__'

async function readStateDoc(docId) {
  try {
    const res = await db.collection(STATE_COLLECTION).doc(docId).get()
    return (res && res.data && typeof res.data === 'object') ? res.data : null
  } catch (e) {
    return null
  }
}

/** 事故追加（prepend) + 封口长度 */
async function recordIncident(entry) {
  const prev = await readStateDoc(INCIDENTS_DOC)
  const list = (prev && Array.isArray(prev.list)) ? prev.list : []
  const nextList = [entry, ...list].slice(0, MAX_INCIDENTS)
  try {
    const patch = { list: nextList, updatedAt: entry.at }
    if (prev) {
      await db.collection(STATE_COLLECTION).doc(INCIDENTS_DOC).update({ data: patch })
    } else {
      // 坑 #6：先读后写（此处依据 prev==null 创建）
      await db.collection(STATE_COLLECTION).add({ data: { _id: INCIDENTS_DOC, ...patch } })
    }
  } catch (e) {
    // 冲突：重读再写（尽力而为，不影响返回 summary）
    try {
      await db.collection(STATE_COLLECTION).doc(INCIDENTS_DOC).update({ data: patch })
    } catch (e2) { /* 再失败就算了 */ }
  }
  return nextList
}

/**
 * 前端未捕获异常上报（action:'clientError'）。
 * 字段先裁剪再落库，同一用户 60s 内只记一条（前端 try/catch 死循环会刷屏）。
 * 累计到 CLIENT_ERROR_REPORT_AT 条时补一条 meta__incidents，
 * 这样 AI/值班脚本能从事故档案里看到「用户端在崩」，不必去翻每个用户的文档。
 */
async function recordClientError(event) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: -1, message: '缺少身份', data: null }

  const docId = `${CLIENT_ERROR_PREFIX}${OPENID}`
  const now = Date.now()
  const prev = await readStateDoc(docId)
  const lastAt = Number(prev && prev.lastAt) || 0
  if (lastAt && now - lastAt < CLIENT_ERROR_THROTTLE_MS) {
    return { code: 0, message: 'throttled', data: { count: Number(prev && prev.count) || 0 } }
  }

  const clip = (v, max) => String(v == null ? '' : v).slice(0, max)
  const entry = {
    at: now,
    kind: clip(event.kind, CLIENT_ERROR_MAX.kind),
    message: clip(event.message, CLIENT_ERROR_MAX.message),
    stack: clip(event.stack, CLIENT_ERROR_MAX.stack),
    page: clip(event.page, CLIENT_ERROR_MAX.page)
  }
  const count = (Number(prev && prev.count) || 0) + 1
  const list = [entry, ...((prev && Array.isArray(prev.list)) ? prev.list : [])].slice(0, CLIENT_ERROR_KEEP)
  const patch = { list, count, lastAt: now }

  try {
    if (prev) {
      await db.collection(STATE_COLLECTION).doc(docId).update({ data: patch })
    } else {
      await db.collection(STATE_COLLECTION).add({ data: { _id: docId, ...patch } })
    }
  } catch (e) {
    // 上报失败不影响前端（前端侧是 fire-and-forget）
    console.warn('[guardian] 前端错误落库失败:', e.message)
    return { code: -1, message: 'write-failed', data: null }
  }

  console.warn(`[guardian] 前端异常上报 user=${OPENID.slice(0, 6)}… count=${count} kind=${entry.kind} msg=${entry.message}`)
  if (count === CLIENT_ERROR_REPORT_AT) {
    await recordIncident({
      at: now,
      type: 'client-error',
      level: 'info',
      detail: `用户 ${OPENID.slice(0, 6)}… 累计 ${count} 次前端异常：${entry.message || '(无消息)'}（页面 ${entry.page || '?'}）`
    })
  }
  return { code: 0, message: 'ok', data: { count } }
}

/** 自愈动作：直接调一轮 watchLive 补位（冷启动失败/触发器失联都会被拉回） */async function healWatch() {
  try {
    const r = await cloud.callFunction({ name: 'watchLive', data: {} })
    return { action: 'watchLive-recalled', result: r.result || null, ok: true }
  } catch (e) {
    return { action: 'watchLive-recalled', error: String(e && e.message || e).slice(0, 200), ok: false }
  }
}

exports.main = async (event = {}) => {
  // 前端崩溃上报走独立入口（不参与自检流程）
  if (event && event.action === 'clientError') return recordClientError(event)

  const at = Date.now()
  const summary = { at, checked: [], incidents: [], healed: null }

  const pacing = await readStateDoc('meta__pacing')
  const metrics = await readStateDoc('meta__metrics')
  const orphans = await readStateDoc('meta__orphans')

  // 1) 心跳年龄：watchLive 是否还在跑
  const lastRound = Number(pacing && pacing.lastRoundAt) || 0
  const ageMin = MathRoundVal((at - lastRound) / 60000)
  summary.checked.push({ key: 'heartbeat-age-min', value: lastRound ? ageMin : 'never-run' })
  if (!lastRound || ageMin > HEARTBEAT_STALE_MIN) {
    summary.healed = await healWatch()
    summary.incidents.push({
      at, type: 'heartbeat-stale', level: 'warn',
      detail: `lastRoundAt 停摆 ${lastRound ? ageMin + ' 分钟' : '从未'}，已触发自动补跑`,
      healed: summary.healed && summary.healed.ok === true
    })
  }

  // 2) 查询连续失败指数退避是否已「卡在高位」
  const streak = Number(pacing && pacing.failStreak) > 0 ? Number(pacing.failStreak) : 0
  summary.checked.push({ key: 'fail-streak', value: streak })
  if (streak >= 5) {
    summary.incidents.push({
      at, type: 'fail-streak', level: 'warn',
      detail: `连续 ${streak} 轮巡检失败，冷却已自动放大到 ${Number(pacing && pacing.waitUntil) > at ? (pacing && Math.round((Number(pacing.waitUntil) - at) / 60000)) : 0} 分钟——大概率抖音页面结构变更，需 AI/人接入修复`
    })
  }

  // 3) 无主关注（坑 #9 同类）
  const orphanCount = Number(orphans && orphans.count) || 0
  summary.checked.push({ key: 'orphans', value: orphanCount })
  if (orphanCount > 0) {
    summary.incidents.push({
      at, type: 'orphans', level: 'info',
      detail: `存在 ${orphanCount} 条无主关注（已自动跳过订阅）：${(orphans && Array.isArray(orphans.uniqueIds) ? orphans.uniqueIds : []).join(', ')}`
    })
  }

  // 4) 巡检窗口的表现异常：推送数/失败数持续 >0 要看
  if (metrics && metrics.pushed > 0 && metrics.failedStreams && metrics.failedStreams > 2) {
    summary.incidents.push({
      at, type: 'push-under-fail', level: 'info',
      detail: `推送 ${metrics.pushed} 但失败 ${metrics.failedStreams} 主播——查是否抖音侧局部故障`
    })
  }

  // 落地里：incidents 增补 + 自检快照（总是写 = 定时器存活证据之二）
  if (summary.incidents.length > 0) {
    for (const inc of summary.incidents) {
      await recordIncident(inc)
    }
  }
  try {
    const prev = await readStateDoc(GUARDIAN_DOC)
    const patch = { at, summary: summary.checked, healed: summary.healed, incidentCount: summary.incidents.length }
    if (prev) {
      await db.collection(STATE_COLLECTION).doc(GUARDIAN_DOC).update({ data: patch })
    } else {
      await db.collection(STATE_COLLECTION).add({ data: { _id: GUARDIAN_DOC, ...patch } })
    }
  } catch (e) { /* 尽力而为 */ }

  return { code: 0, message: 'guardian-check-done', data: summary }
}

/** 四舍五入，undefined 安全 */
function MathRoundVal(x) {
  return Number.isFinite(x) ? Math.round(x) : 0
}
