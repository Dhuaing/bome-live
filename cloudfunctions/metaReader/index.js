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
 *
 * 身份门控（2026-11-17 加固）：这是唯一无身份校验的云函数，补一道
 * ADMIN_OPENIDS 环境变量白名单（逗号分隔 openid，在函数配置的
 * envVariables 里设置）。未设置时保持向后兼容放行 + console.warn 提示。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const META_IDS = ['meta__guardian', 'meta__incidents', 'meta__pacing', 'meta__metrics', 'meta__orphans']

/** 管理员白名单：从函数环境变量读，逗号分隔 */
function getAdminOpenids() {
  const raw = (process.env.ADMIN_OPENIDS || '').trim()
  if (!raw) return null
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

exports.main = async () => {
  // ── 身份门控：白名单已配置时，非管理员一律拒绝 ──
  const admins = getAdminOpenids()
  if (admins) {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID || !admins.includes(OPENID)) {
      console.warn('[metaReader] 非管理员调用被拒:', OPENID ? OPENID.slice(0, 6) + '…' : '(无身份)')
      return { code: -1, message: '无权限（仅管理员可读运维档案）', data: null }
    }
  } else {
    // 未配置 = 保持旧行为放行（运维档案不含 PII，风险可接受），
    // 但把提醒打到日志里，催配置
    console.warn('[metaReader] ADMIN_OPENIDS 未配置，当前对所有人放行（建议在函数环境变量配置白名单）')
  }

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
