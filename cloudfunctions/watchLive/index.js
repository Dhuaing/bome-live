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
const { decideGuardianHeal } = require('./_shared/watchdog')
const { readDocOrNull } = require('./_shared/state-doc')

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
/** 轮级互斥锁：同一时刻只允许一轮巡检在跑（guardian healWatch 补调与定时轮并发时防双推送双扣额度） */
const LOCK_DOC = 'meta__lock'
/** 轮锁自动过期：持锁轮被杀（实例回收/超时）后，最多这么久就有下一轮能接手 */
const LOCK_MS = 5 * 60 * 1000
/** guardian 的自检快照（由 guardian 每天 08:00/20:00 写） */
const GUARDIAN_DOC = 'meta__guardian'
/** 看守者档案：watchLive 补跑 guardian 的记录（守护者自己挂了不会知道） */
const WATCHDOG_DOC = 'meta__watchdog'

// 新环境兜底：集合缺失时自建（管理端 SDK），部署即可用
const { ensureCollection } = require('./_shared/ensure-collection')

/** 连续失败多少轮后发一次故障告警 */
const FAIL_ALERT_THRESHOLD = 3
/** 告警冷却：两次故障告警之间至少间隔的时间 */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000
/**
 * 无主关注档案里最多存几个 uniqueId 样本。
 * 全量写进单文档会随脏数据增长撑大文档（单文档有体积上限），
 * 而这份档案只用于「让人看见有人要修」，留样本 + 总数足够。
 */
const ORPHAN_SAMPLE_MAX = 20

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

/**
 * 读一条 watchState 文档。
 * 不存在 → null；**其他读失败一律抛错**（坑 #18：把权限/网络错误当成空状态，
 * 会让节奏档失效绕冷却、让健康摘要误报「从未运行」）。
 */
async function getStateDoc(docId) {
  return readDocOrNull(db, STATE_COLLECTION, docId)
}

/** 幂等写一条 watchState 文档 */
async function putStateDoc(docId, patch) {
  const coll = db.collection(STATE_COLLECTION)
  // 注意：云开发 doc().update() 对不存在的文档是「静默成功」的空操作（不报错也不创建），
  // 不能靠「update 失败再 add」兜底新建，必须先读后写。
  // 读失败不再当「不存在」：否则一次抖动就会走 add → 撞 _id 冲突 → 再 update，
  // 把一次真实的数据库故障伪装成成功写入。
  const existing = await readDocOrNull(db, STATE_COLLECTION, docId)
  if (existing) {
    await coll.doc(docId).update({ data: patch })
    return
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

// ────────────────────────── 轮级互斥锁 ──────────────────────────

/**
 * 抢占轮锁（CAS，并发安全）。
 *
 * 为什么不用「条件更新 lockUntil<now」一把梭：两个并发实例都能看到
 * 锁已过期、都写入新过期时间、都拿到 updated=1——条件更新做不了
 * compare-and-swap。这里把**旧值**放进更新条件：写是原子的，后写者
 * 的条件对着已被先写者改过的文档求值必然失配（updated=0）。
 *
 * 无文档时用 add 占位（自定义 _id 冲突即有人抢先）。
 * 三次尝试都失败 = 确有他轮持锁，直接放弃本轮。
 */
async function acquireRoundLock(now) {
  const coll = db.collection(STATE_COLLECTION)
  const _ = db.command
  const token = `${now.toString(36)}x${Math.floor(Math.random() * 1e9).toString(36)}`
  const lockUntil = now + LOCK_MS

  for (let attempt = 0; attempt < 3; attempt++) {
    // 读失败不再当「没有锁」：真·读不通时直接抛错（外层转 error-backoff），
    // 而不是走 add 撞 _id 冲突 → 重试 → 最后报「他人持锁」，
    // 把一次数据库故障伪装成「有别的轮在跑」（坑 #18）。
    const got = await readDocOrNull(db, STATE_COLLECTION, LOCK_DOC)
    const prev = got && Object.keys(got).length ? got : null

    if (prev && Number(prev.lockUntil) > now) {
      return { ok: false } // 他人持锁中
    }

    if (!prev) {
      try {
        await coll.add({ data: { _id: LOCK_DOC, lockUntil, lockToken: token, lockedAt: now } })
        return { ok: true, token }
      } catch (e) {
        continue // 已被并发抢建，重读再判
      }
    }

    // 已过期 → CAS 抢占：条件带旧值（字段缺失时按「无该字段」匹配）
    const cond = prev.lockUntil === undefined || prev.lockUntil === null
      ? { lockUntil: _.exists(false) }
      : { lockUntil: Number(prev.lockUntil) || 0 }
    try {
      const r = await coll.where({ _id: LOCK_DOC, ...cond })
        .update({ data: { lockUntil, lockToken: token, lockedAt: now } })
      if (r && r.stats && r.stats.updated > 0) return { ok: true, token }
    } catch (e) {
      // 条件更新失败按持锁失败处理，不中断巡检主流程
    }
  }
  return { ok: false }
}

/**
 * 释放轮锁（条件带 token：只释放自己还持有的锁）。
 * 轮被杀/超过 LOCK_MS 后锁自动过期，他轮可接手——过期后本函数的
 * 释放因 token 已被覆盖而自然空操作，不会误放他人刚抢到的锁。
 */
async function releaseRoundLock(token) {
  try {
    await db.collection(STATE_COLLECTION)
      .where({ _id: LOCK_DOC, lockToken: token })
      .update({ data: { lockUntil: 0, lockToken: '', releasedAt: Date.now() } })
  } catch (e) {
    console.warn('[watchLive] 释放轮锁失败（将由 LOCK_MS 过期兜底）:', e.message)
  }
}

// ────────────────────────── 看守 guardian ──────────────────────────

/**
 * 看守 guardian：它超出 26h 没自检就补跑一次。
 *
 * guardian 是「每天 08:00/20:00」的定时任务，它自己挂了不会有任何感知
 * （2026-11-05 触发器丢失，18 天无人发现，期间零告警）。watchLive 每分钟
 * 都在跑，是系统里唯一持续活着的进程，由它顺手看守最省事。
 *
 * 递归防护：guardian 发现心跳停摆会反向补跑 watchLive，嵌套那一轮必须被
 * 拦住。做法是**先写 lastHealAt 再调用**——嵌套轮读到刚写的时间戳会判成
 * cooldown（decideGuardianHeal 见 _shared/watchdog.js）。
 */
async function watchGuardian(now) {
  const [g, w] = await Promise.all([getStateDoc(GUARDIAN_DOC), getStateDoc(WATCHDOG_DOC)])
  const d = decideGuardianHeal({
    now,
    guardianAt: g && g.at,
    lastHealAt: w && w.lastHealAt
  })
  if (!d.heal) return d

  console.error(`[watchLive] guardian 停摆判定=${d.reason}，补跑一次 guardian`)
  // 先落「补跑中」：让嵌套的那一轮 watchLive 立刻进入冷却，切断递归
  await putStateDoc(WATCHDOG_DOC, { lastHealAt: now, lastHealOk: null, lastHealReason: d.reason })

  let ok = false
  let error = ''
  try {
    const r = await cloud.callFunction({ name: 'guardian', data: {} })
    ok = !!(r && r.result && r.result.code === 0)
    if (!ok) error = `guardian 返回 code=${r && r.result && r.result.code}`
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 200)
  }

  await putStateDoc(WATCHDOG_DOC, {
    lastHealAt: now,
    lastHealOk: ok,
    lastHealReason: d.reason,
    lastHealError: error,
    lastHealCheckedAt: Date.now()
  })
  if (!ok) console.error('[watchLive] 补跑 guardian 失败:', error)
  return { ...d, healed: ok, error }
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
async function handleStreamSuccess(uniqueId, subscribers, info, config, roundStartedAt) {
  await removeStateDoc(`fail__${uniqueId}`)

  let pushed = 0
  for (const openid of subscribers) {
    const docId = `${openid}__${uniqueId}`
    const prev = await getStateDoc(docId)
    const { next, notify, decision } = evaluate(prev, info)

    // 记录状态转场与会触发提醒的判定，便于从云函数日志复盘误报。
    // 不写 openid、完整直播间标题或订阅额度；uniqueId 是公开主播标识。
    if (!prev || notify || prev.status !== decision.currentStatus) {
      console.log('[watchLive] 判定审计:', JSON.stringify({
        uniqueId,
        // 本轮巡检起点 + 本条判定时刻：让单行日志自带「哪一轮、什么时候」
        roundAt: roundStartedAt,
        checkedAt: decision.checkedAt,
        reason: decision.reason,
        previousStatus: decision.previousStatus,
        currentStatus: decision.currentStatus,
        previousStartTime: decision.previousStartTime,
        startTime: decision.startTime,
        driftMs: decision.driftMs,
        titlesComparable: decision.titlesComparable,
        sameTitle: decision.sameTitle,
        notify
      }))
    }

    const page = (config.page || '').includes('{uniqueId}')
      ? (config.page || '').replace('{uniqueId}', uniqueId)
      : config.page || 'pages/home/index'

    if (!notify) {
      // 不推送：无副作用，直接落状态
      await putStateDoc(docId, { openid, uniqueId, ...next })
      continue
    }

    // 要推送：改为「先推送、按结果落状态」的写时序。
    // 旧时序（先写状态再推）的坑：实例在写状态后、推送前被杀 → 状态已是
    // 「本场次已推」，下轮不再判推 → 推送永久丢失（丢的是用户攒的额度）。
    // 新时序按推送结果分档：
    // - ok            → 写 next（lastPushAt 锚点由 evaluate 带上，合并窗靠它）
    // - 43101（没额度）→ 归零账本 + 写 next：锚点保留防掉线重开时的重试风暴
    // - CONFIG/200014/47003 → 写 next + break：配置/参数问题对所有人都会失败，
    //   继续刷只会烧调用；落 next 防止配置修复后同轮补推刷量
    // - 其他瞬时失败  → 不写状态：下轮按旧 prev 重判自动重试（at-least-once，
    //   宁可重复判定也不丢推送）
    const r = await sendSubs(
      openid,
      config.templateId,
      page,
      buildSubsData(info, config.keys),
      config.miniprogramState || 'formal'
    )
    if (r.ok) {
      pushed += 1
      console.log('[watchLive] 提醒发送结果:', JSON.stringify({ uniqueId, roundAt: roundStartedAt, result: 'sent', errCode: 0 }))
      await recordQuotaEvent(openid, 'spend')
      await putStateDoc(docId, { openid, uniqueId, ...next })
    } else if (r.errCode === 43101) {
      // 平台确认没有额度：账本归零校准（防账本虚高）
      console.warn('[watchLive] 提醒发送结果:', JSON.stringify({ uniqueId, roundAt: roundStartedAt, result: 'no-quota', errCode: r.errCode, errMsg: String(r.errMsg || '').slice(0, 120) }))
      await recordQuotaEvent(openid, 'zero')
      await putStateDoc(docId, { openid, uniqueId, ...next })
    } else if (r.errCode === 'CONFIG' || r.errCode === 200014 || r.errCode === 47003) {
      console.warn('[watchLive] 提醒发送结果:', JSON.stringify({ uniqueId, roundAt: roundStartedAt, result: 'failed-final', errCode: r.errCode, errMsg: String(r.errMsg || '').slice(0, 120) }))
      console.error(`[watchLive] 推送配置问题(${r.errCode})，落状态并跳过本主播后续用户以防刷量`)
      await putStateDoc(docId, { openid, uniqueId, ...next })
      break
    } else {
      console.warn('[watchLive] 提醒发送结果:', JSON.stringify({ uniqueId, roundAt: roundStartedAt, result: 'failed-retryable', errCode: r.errCode, errMsg: String(r.errMsg || '').slice(0, 120) }))
      console.warn(`[watchLive] 推送失败 err=${r.errCode}（状态未落，下轮重试）`)
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

    // ── 轮锁：同一时刻只允许一轮巡检在跑 ──
    // guardian healWatch 补调与每分钟定时轮并发时，无锁会双巡检双推送
    // （双扣用户额度）。拿不到锁直接返回：持锁轮负责本轮巡检。
    // 持锁轮被硬杀时锁由 LOCK_MS 过期兜底，不会永久卡死。
    const lock = await acquireRoundLock(roundStartedAt)
    if (!lock.ok) {
      console.log('[watchLive] 已有另一轮持有轮锁，本轮跳过')
      return { code: 0, message: 'lock-skip', pushed: 0 }
    }

    // 无论本轮怎么退出（正常/异常）都释放锁；实例被硬杀时由 LOCK_MS 过期兜底
    try {
      return await runRound(config, roundStartedAt)
    } finally {
      await releaseRoundLock(lock.token)
    }
  } catch (err) {
    console.error('[watchLive] 本轮异常:', err)
    // 定时触发场景下抛错会记录在云函数日志里，可被开发者工具看到。
    // 异常轮也退避，避免抖音侧故障时每分钟白烧触发器调用。
    // （failStreak 用现读值：本轮内 PACING 可能已被更新过。
    //   历史 bug：pacing 曾声明在 try 块内，此处越界引用 → ReferenceError
    //   被本 try 静默吞掉，「异常轮退避」整段是死代码）
    try {
      const prevPacing = await getStateDoc(PACING_DOC)
      const failStreak = (Number(prevPacing && prevPacing.failStreak) > 0 ? Number(prevPacing.failStreak) : 0) + 1
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

/** 一轮巡检主体（持锁成功后才会进来）：节奏门 → 巡检 → 自我调优 */
async function runRound(config, roundStartedAt) {
  // ── 看守 guardian：放在节奏门之前 ──
  // 冷却期内也要检查，否则「巡检在正常跳轮 + guardian 已死」会互相掩盖。
  // 失败只记日志，不影响本轮巡检。
  try {
    await watchGuardian(roundStartedAt)
  } catch (e) {
    console.warn('[watchLive] watchdog 检查失败（不影响巡检）:', e.message)
  }

  // ── 节奏门：冷却期内只刷新心跳不巡检，省 QPS ──
  // 注意：即使跳轮也必须写 PACING 文档——它是「定时器是否还活着」的心跳证据。
  // 读失败不降级成「没有冷却」（坑 #18）：那样每轮都会全量巡检、白烧调用量，
  // 异常应该抛给外层写 error-backoff，而不是被当成「第一次运行」。
  const pacing = await getStateDoc(PACING_DOC)
  if (pacing && Number(pacing.waitUntil) > roundStartedAt) {
    await putStateDoc(PACING_DOC, {
      lastRoundAt: roundStartedAt,
      waitUntil: pacing.waitUntil,
      mode: 'cooldown'
    })
    console.log(`[watchLive] 冷却期至 ${new Date(Number(pacing.waitUntil)).toISOString()}，本轮跳过（roundAt=${roundStartedAt}）`)
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
  // 但计数上报（meta__orphans），系统自己把坏数据点亮而不是埋着。
  // Set 去重：同一用户对同一主播存在重复关注记录时（历史脏数据），
  // 只巡检/推送一次——重复推送会双扣用户额度。
  // String() 包裹：_openid 理论上可非字符串，后续 slice/拼接统一在此归一。
  const orphans = []
  const byStreamer = new Map()
  for (const f of follows) {
    const id = f && f.uniqueId
    if (!id) continue
    if (!f._openid) {
      orphans.push(id)
      continue
    }
    const openid = String(f._openid)
    if (!byStreamer.has(id)) byStreamer.set(id, new Set())
    byStreamer.get(id).add(openid)
  }
  if (orphans.length > 0) {
    console.error(`[watchLive] 发现 ${orphans.length} 条无主关注（_openid 缺失，跳过巡检订阅）: ${orphans.join(', ')}`)
    // 只存样本：全量 uniqueId 写单文档会随脏数据增长撞体积上限（坑 #18 延伸）
    await putStateDoc('meta__orphans', {
      count: orphans.length,
      uniqueIds: orphans.slice(0, ORPHAN_SAMPLE_MAX),
      sampled: orphans.length > ORPHAN_SAMPLE_MAX,
      lastSeenAt: Date.now()
    })
  }

  let pushed = 0
  let failedStreams = 0
  let livingStreams = 0
  for (const [uniqueId, openidSet] of byStreamer) {
    const openids = Array.from(openidSet)
    const q = await queryStatus(uniqueId)
    if (!q.ok) {
      failedStreams += 1
      await handleStreamFailure(uniqueId, openids, q.error, config)
      continue
    }
    if (q.info && q.info.status === 'living') livingStreams += 1
    pushed += await handleStreamSuccess(uniqueId, openids, q.info, config, roundStartedAt)
  }

  console.log(
    `[watchLive] 本轮完成：主播 ${byStreamer.size} 个 / 用户记录 ${follows.length} 条，推送 ${pushed} 条（roundAt=${roundStartedAt}）`
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
}
