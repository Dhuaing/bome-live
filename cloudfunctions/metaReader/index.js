/**
 * metaReader：运维档案只读器（duty 值班的云端读数通道）
 *
 * 背景：duty.js 原本靠 CDP 驱动 IDE 云控制台 webview 读 meta__* 档案，
 * 但云控制台 webview 经常没开（读数长期降级）。此函数给 duty 一条
 * 不依赖控制台的读数路：模拟器 appservice 里 wx.cloud.callFunction 即可。
 *
 * 安全边界：只读运维档案（guardian/incidents/pacing/metrics/orphans），
 * 不碰 follows/watchState 用户数据，无写操作，无参数；
 * 暴露的仅是运维统计（计数/心跳/事故摘要），不含用户 PII。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const META_IDS = ['meta__guardian', 'meta__incidents', 'meta__pacing', 'meta__metrics', 'meta__orphans']

exports.main = async () => {
  const db = cloud.database()
  const coll = db.collection('watchState')
  const out = {}
  for (const id of META_IDS) {
    try {
      const r = await coll.doc(id).get()
      out[id.replace('meta__', '')] = r.data || null
    } catch (e) {
      // 不存在/读失败都落 null——由调用方区分「读失败」与「无数据」
      out[id.replace('meta__', '')] = null
    }
  }
  // 至少一份真读上（非 null）才算成功，否则如实报 not-found
  const gotAny = Object.values(out).some((v) => v && typeof v === 'object')
  return { code: 0, message: gotAny ? 'ok' : 'meta-not-found', data: out }
}
