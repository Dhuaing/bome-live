// 订阅消息额度账本：攒额度 + 读额度
//
// 背景：微信没有「查询剩余订阅额度」的 API，一次性订阅的额度只在
// 微信平台侧记账。这里自建账本 subsQuota（docId = openid，一人一档）：
// - 前端每收到一次 accept 调 action='earn'（+1，带 requestId 幂等）
// - 云函数 watchLive 每次推送成功写 spend（-1）、43101 写 zero（归零校准）
// 展示原则：宁可虚低不虚高（见 _shared/quota-ledger.js 头注释）。
//
// 幂等：earn 带 requestId（前端每次 requestSubscribeMessage 生成一个）。
// 记账前先在 subsQuotaEvents 集合占位（_id = `${openid}__${requestId}`），
// 占位冲突 = 同一次 accept 的重试/双击 → 忽略，不再重复 +1。
// 占位文档按 openid 打前缀，避免跨用户串号。
//
// 返回约定（前端 services/cloud.ts callFunction）：{ code, message, data }
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const QUOTA_COLLECTION = 'subsQuota'
/** earn 幂等占位集合：一个 requestId 一条，用完即留（审计 + 防重放） */
const EVENTS_COLLECTION = 'subsQuotaEvents'
const { ensureCollection } = require('./_shared/ensure-collection')
const { readQuotaDoc, commitEvent, isDupKeyError } = require('./_shared/quota-ledger')

/** action 白名单：未知 action 一律拒绝，不再兜底成 get（防误用/探测） */
const ALLOWED_ACTIONS = new Set(['get', 'earn'])

/** requestId 合法性：前端生成的 `时间戳-随机串`，64 内安全字符 */
function isValidRequestId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)
}

function ledgerPayload(doc) {
  return {
    quota: (doc && doc.quota) || 0,
    totalEarned: (doc && doc.totalEarned) || 0,
    totalSpent: (doc && doc.totalSpent) || 0,
    correctedAt: (doc && doc.correctedAt) || 0
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { code: -1, message: '未获取到用户身份', data: null }
  }

  const action = (event && event.action) || 'get'
  if (!ALLOWED_ACTIONS.has(action)) {
    return { code: -1, message: `未知 action: ${action}`, data: null }
  }

  try {
    await ensureCollection(db, QUOTA_COLLECTION)

    if (action === 'earn') {
      // 前端刚收到一次「允许」（随带调用，账本 +1）。
      // 幂等占位：同一 requestId 只记一次（重试/双击/网络重发不双记账）
      const requestId = event && event.requestId
      if (isValidRequestId(requestId)) {
        await ensureCollection(db, EVENTS_COLLECTION)
        try {
          await db.collection(EVENTS_COLLECTION).add({
            data: { _id: `${OPENID}__${requestId}`, type: 'earn', createdAt: Date.now() }
          })
        } catch (e) {
          if (isDupKeyError(e)) {
            // 同一次 accept 已经记过账：直接回读当前账本返回
            const dup = await readQuotaDoc(db, QUOTA_COLLECTION, OPENID)
            return { code: 0, message: 'duplicate-earn-ignored', data: ledgerPayload(dup) }
          }
          throw e
        }
      } else {
        console.warn('[notifyQuota] earn 缺少/非法 requestId，退化为非幂等记账（旧前端兼容）')
      }

      const next = await commitEvent(db, QUOTA_COLLECTION, OPENID, { type: 'earn' })
      return { code: 0, message: 'earned', data: next ? ledgerPayload(next) : null }
    }

    const doc = await readQuotaDoc(db, QUOTA_COLLECTION, OPENID)
    return { code: 0, message: 'ok', data: ledgerPayload(doc) }
  } catch (err) {
    console.error('[notifyQuota] error:', err)
    return { code: -1, message: err.message || '额度账本操作失败', data: null }
  }
}
