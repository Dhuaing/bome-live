/**
 * 守护者的守护者（watchdog）——纯决策函数，无 I/O，便于单测。
 *
 * 为什么需要：
 * guardian 只是「每天 08:00 / 20:00」的定时任务，它自己挂了自己不会知道。
 * 2026-11-05~11-23 实测：guardian 的定时触发器丢了 18 天，期间零告警——
 * 因为它唯一的事故出口是往数据库写 meta__incidents，而没人会主动去看数据库。
 * watchLive 每分钟都在跑，是系统里唯一「持续活着」的进程，所以由它顺手
 * 看守 guardian：发现 meta__guardian.at 过期就直接补调一次。
 *
 * 规则：
 * - guardian 每天两次，所以超过 26h 没自检 = 一定丢了（多 2h 容忍执行漂移）
 * - 补跑失败要冷却 6h，否则每分钟调一次 guardian 是白烧调用量
 */

/** guardian 多久没自检就判定停摆（26 小时；每天两次 + 2h 容忍） */
const STALE_MS = 26 * 60 * 60 * 1000
/** 补跑失败后的重试冷却 */
const HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 巡检心跳多久算停摆（与 guardian 自己的判定保持一致） */
const HEARTBEAT_STALE_MIN = 20
/** 连续失败达到这个轮数就该有人管了（与 guardian 阈值一致） */
const FAIL_STREAK_ALERT = 5
/** 心跳超过这么久完全没动 = 巡检链路整体死亡，健康度直接判 bad */
const HEARTBEAT_DEAD_MIN = 6 * 60

/**
 * 决定这一轮要不要补跑 guardian。
 *
 * @param {{ now?: number, guardianAt?: number, lastHealAt?: number }} input
 * @param {{ staleMs?: number, cooldownMs?: number }} [opts]
 * @returns {{ heal: boolean, reason: 'never-run'|'fresh'|'cooldown'|'stale', ageMs: number|null }}
 */
function decideGuardianHeal(input = {}, opts = {}) {
  const now = Number(input.now) || 0
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : STALE_MS
  const cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : HEAL_COOLDOWN_MS

  const guardianAt = Number(input.guardianAt) || 0
  const lastHealAt = Number(input.lastHealAt) || 0

  if (!guardianAt) return { heal: true, reason: 'never-run', ageMs: null }

  const ageMs = now - guardianAt
  if (ageMs <= staleMs) return { heal: false, reason: 'fresh', ageMs }
  // 补跑过但还没到冷却期——注意：watchLive 补跑 guardian 时，guardian 会反向
  // 补跑 watchLive，嵌套的那一轮必须在这里被拦住，否则递归互调
  if (lastHealAt > 0 && now - lastHealAt < cooldownMs) {
    return { heal: false, reason: 'cooldown', ageMs }
  }
  return { heal: true, reason: 'stale', ageMs }
}

/**
 * 体检汇总：把几张运维档案折算成「给人的一句话 + 分级」。
 * metaReader 的 mode:'health' 与前端「系统状态」徽标共用，故做成纯函数。
 *
 * 分级：
 * - ok    全部正常
 * - warn  有异常但巡检还在跑（可以自己恢复的那种）
 * - bad   巡检链路整体死了/从未跑起来，需要人介入
 *
 * @returns {{
 *   level: 'ok'|'warn'|'bad',
 *   ok: boolean,
 *   reasons: string[],
 *   heartbeatAgeMin: number|null,
 *   guardianAgeMin: number|null,
 *   failStreak: number,
 *   incidentsOpen: number,
 *   lastHealOk: boolean|null
 * }}
 */
function summarizeHealth(input = {}, opts = {}) {
  const now = Number(input.now) || 0
  const heartbeatStaleMin = Number(opts.heartbeatStaleMin) > 0 ? Number(opts.heartbeatStaleMin) : HEARTBEAT_STALE_MIN
  const guardianStaleMs = Number(opts.guardianStaleMs) > 0 ? Number(opts.guardianStaleMs) : STALE_MS

  const pacing = input.pacing || null
  const guardian = input.guardian || null
  const watchdog = input.watchdog || null
  const incidents = input.incidents || null

  const lastRound = Number(pacing && pacing.lastRoundAt) || 0
  const guardianAt = Number(guardian && guardian.at) || 0
  const heartbeatAgeMin = lastRound ? Math.max(0, Math.round((now - lastRound) / 60000)) : null
  const guardianAgeMin = guardianAt ? Math.max(0, Math.round((now - guardianAt) / 60000)) : null
  const failStreak = Number(pacing && pacing.failStreak) > 0 ? Number(pacing.failStreak) : 0
  const lastHealOk = watchdog && typeof watchdog.lastHealOk === 'boolean' ? watchdog.lastHealOk : null
  const list = Array.isArray(incidents && incidents.list) ? incidents.list : []
  const incidentsOpen = list.filter((x) => x && x.level !== 'resolved').length

  const reasons = []
  if (heartbeatAgeMin === null) reasons.push('巡检从未运行')
  else if (heartbeatAgeMin > heartbeatStaleMin) reasons.push(`巡检心跳停摆 ${heartbeatAgeMin} 分钟`)
  if (guardianAgeMin === null) reasons.push('守护者从未运行')
  else if ((now - guardianAt) > guardianStaleMs) reasons.push(`守护者停摆 ${guardianAgeMin} 分钟`)
  if (failStreak >= FAIL_STREAK_ALERT) reasons.push(`连续失败 ${failStreak} 轮`)
  if (lastHealOk === false) reasons.push('上次守护者补跑失败')

  const dead = heartbeatAgeMin === null || heartbeatAgeMin > HEARTBEAT_DEAD_MIN
  const level = reasons.length === 0 ? 'ok' : (dead ? 'bad' : 'warn')

  return {
    level,
    ok: level === 'ok',
    reasons,
    heartbeatAgeMin,
    guardianAgeMin,
    failStreak,
    incidentsOpen,
    lastHealOk
  }
}

module.exports = {
  decideGuardianHeal,
  summarizeHealth,
  STALE_MS,
  HEAL_COOLDOWN_MS,
  HEARTBEAT_STALE_MIN,
  HEARTBEAT_DEAD_MIN,
  FAIL_STREAK_ALERT
}
