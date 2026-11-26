/**
 * watchState 文档读取：严格区分「文档不存在」与「读失败」。
 *
 * 背景（坑 #18）：`doc().get()` 对不存在的文档会抛错，和网络抖动、权限错误
 * 走的是同一条 catch。以前一律 `return null`，后果是：
 *   - 节奏档读失败 → 当成「没有冷却」→ 每轮都全量巡检，白烧调用量
 *   - 守护档读失败 → 当成「guardian 从未运行」→ 误触发补跑
 *   - 健康摘要读失败 → 当成「巡检从未跑过」→ 误报 🔴（方向安全，但仍是假信息）
 *
 * 原则：**只有「确实不存在」才按空档处理，其余一律抛错**，由调用方决定
 * 跳过/退避/报错。绝不把读失败伪装成「没有状态」。
 */

/** 云开发「资源不存在」类错误码（与 _shared/quota-ledger.js 保持同一判据） */
const NOT_EXIST_CODE = -502005

/** 判断错误是否为「文档不存在」 */
function isNotExistError(e) {
  const code = e && (e.errCode !== undefined ? e.errCode : e.code)
  if (code === NOT_EXIST_CODE) return true
  const s = String((e && (e.errMsg || e.message)) || e)
  return /not exists|not_exist|NOT_FOUND|does not exist/i.test(s)
}

/**
 * 读一条文档。
 * - 不存在 → null
 * - 其他错误 → 抛出（不要 catch 成 null）
 *
 * @param {object} db   cloud.database() 实例
 * @param {string} coll 集合名
 * @param {string} docId 文档 _id
 */
async function readDocOrNull(db, coll, docId) {
  try {
    const res = await db.collection(coll).doc(docId).get()
    return res && res.data && typeof res.data === 'object' ? res.data : null
  } catch (e) {
    if (isNotExistError(e)) return null
    throw e
  }
}

module.exports = { isNotExistError, readDocOrNull, NOT_EXIST_CODE }
