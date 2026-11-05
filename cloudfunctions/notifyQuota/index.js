// 订阅消息额度账本：攒额度 + 读额度
//
// 背景：微信没有「查询剩余订阅额度」的 API，一次性订阅的额度只在
// 微信平台侧记账。这里自建账本 subsQuota（docId = openid，一人一档）：
// - 前端每收到一次 accept 调 action='earn'（+1）
// - 云函数 watchLive 每次推送成功写 spend（-1）、43101 写 zero（归零校准）
// 展示原则：宁可虚低不虚高（见 _shared/quota-ledger.js 头注释）。
//
// 返回约定（前端 services/cloud.ts callFunction）：{ code, message, data }
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const QUOTA_COLLECTION = 'subsQuota'
const { ensureCollection } = require('./_shared/ensure-collection')
const { readQuotaDoc, commitEvent } = require('./_shared/quota-ledger')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { code: -1, message: '未获取到用户身份', data: null }
  }

  const action = (event && event.action) || 'get'

  try {
    await ensureCollection(db, QUOTA_COLLECTION)

    if (action === 'earn') {
      // 前端刚收到一次「允许」（随带调用，账本 +1）。幂等性靠调用约定：
      // 每次 requestSubscribeMessage 的 accept 才发一次 earn。
      const next = await commitEvent(db, QUOTA_COLLECTION, OPENID, { type: 'earn' })
      return { code: 0, message: 'earned', data: { quota: next.quota, totalEarned: next.totalEarned, totalSpent: next.totalSpent } }
    }

    const doc = await readQuotaDoc(db, QUOTA_COLLECTION, OPENID)
    return {
      code: 0,
      message: 'ok',
      data: {
        quota: (doc && doc.quota) || 0,
        totalEarned: (doc && doc.totalEarned) || 0,
        totalSpent: (doc && doc.totalSpent) || 0,
        correctedAt: (doc && doc.correctedAt) || 0
      }
    }
  } catch (err) {
    console.error('[notifyQuota] error:', err)
    return { code: -1, message: err.message || '额度账本操作失败', data: null }
  }
}
