/**
 * 管理端集合自建兜底（服务端 SDK 专用）。
 *
 * 背景：云开发的集合必须先存在才能读写；新环境初始化阶段
 * （刚开通、或集合被删掉）直接 add/get 会报错。
 * 本模块用管理端 SDK 的 createCollection 在读写前保证集合存在，
 * 实现「部署即可用」，不依赖人工在控制台手动创建。
 *
 * 用法：
 *   const { ensureCollection } = require('./_shared/ensure-collection')
 *   await ensureCollection(db, 'follows')   // db 由调用方传入
 *
 * 云函数间共享：源在 cloudfunctions/_shared/，经 sync-cloud-shared.js 同步副本。
 */

/** 已保证存在的集合（进程内缓存，避免每分钟巡检重复打点） */
const ensured = new Set()

/**
 * 幂等创建集合；不存在则建，已存在当作成功。
 * 创建失败不抛出——集合缺失的真实错误会在后续业务调用里暴露，
 * 这里只负责「大概率能建」的兜底。
 */
async function ensureCollection(db, name) {
  if (ensured.has(name)) return true
  try {
    await db.createCollection(name)
    console.log(`[ensureCollection] 已创建集合 ${name}`)
  } catch (e) {
    const msg = (e && (e.errCode !== undefined ? String(e.errCode) : e.message)) || String(e)
    // 已存在（通常报 -501001 RESOURCE_NOT_FOUND 或具体错误文本）静默视为成功
    if (!/(-501001|already exists|已存在|existed)/i.test(msg)) {
      console.warn(`[ensureCollection] ${name} 创建异常: ${msg}`)
    }
  }
  ensured.add(name)
  return true
}

module.exports = { ensureCollection }
