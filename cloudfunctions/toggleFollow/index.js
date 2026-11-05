// 关注 / 取关主播云函数
//
// 字段契约（与前端 services/streamer.ts 对齐）：
//   入参：{ uniqueId, name?, avatar?, roomUrl?, action: 'follow' | 'unfollow' }
//   返回：{ code: 0, data: { followed: boolean } }
//
// 注意：历史版本收的是 streamerId，与前端实际发送的 uniqueId 对不上，
// 导致微信端每次点关注都返回"参数不完整"。这里同时兼容两者。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'follows'

/** 兼容 HTTP 网关调用（参数在 event.body / queryStringParameters） */
const { parseParams } = require('./_shared/parseParams')
// 记录构造规则与 H5 端、前端共用同一份生成代码
const { buildFollowRecord, isValidUniqueId, isValidAction, buildFollowDocId } = require('./_shared/follow-record')
// 新环境兜底：集合缺失时自建，部署即可用
const { ensureCollection } = require('./_shared/ensure-collection')

/** 兼容老字段名 streamerId */
function readUniqueId(params) {
  return String(params.uniqueId || params.streamerId || '').trim()
}

/**
 * 查询该用户是否已关注此主播。
 *
 * 必须显式带上 _openid：云函数用的是管理端 SDK（wx-server-sdk），
 * 它不会自动按当前用户过滤。漏掉这个条件会导致跨用户读写。
 */
async function findExisting(coll, openid, uniqueId) {
  const res = await coll.where({ _openid: openid, uniqueId }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/** 关注：新增或更新记录 */
async function follow(coll, openid, uniqueId, params) {
  const found = await findExisting(coll, openid, uniqueId)
  const record = buildFollowRecord({ ...params, uniqueId }, found)

  if (found) {
    // 更新时只写可变字段，不动 _id / _openid / createdAt
    const { id, uniqueId: uid, createdAt, ...patch } = record
    await coll.doc(found._id).update({ data: patch })
    return
  }
  // 显式带上调用者 _openid：不依赖 SDK 自动注入——自动注入在部分调用
  // 上下文（真机预览/非微信入口）会整个缺失，曾踩过：两条关注落库无
  // _openid，任何用户都查不到它们，巡检端还白跑（watchState 出现
  // undefined__* 档）。读取端 findExisting 一直是显式 where，写入就不能
  // 靠隐式行为补齐（坑 #9）
  //
  // 健壮性：新增用确定性 _id（openid__uniqueId）而非自增——同一用户对
  // 同一主播的并发双插（快速双击/网络重试两路请求）在 findExisting 的
  // 读-写窗口里都会看到「不存在」而各自 add 一条；用 _id 唯一性把
  // 第二条天然堵死，冲突时回退 update 保证语义仍是「关注成功」
  const docId = buildFollowDocId(openid, uniqueId)
  try {
    await coll.add({ data: { _id: docId, ...record, _openid: openid } })
  } catch (e) {
    // 并发第二条到达（_id 已存在）→ 覆盖为最新推演值，幂等语义不变
    const isConflict = /exists|duplicate|(_id|602)/i.test(String(e.errCode || e.errMsg || e.message))
    if (!isConflict) throw e
    await coll.doc(docId).update({ data: record })
  }
}

/** 取关：幂等，不存在也算成功 */
async function unfollow(coll, openid, uniqueId) {
  const found = await findExisting(coll, openid, uniqueId)
  if (found) await coll.doc(found._id).remove()
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) {
      return { code: -1, message: '未获取到用户身份', data: null }
    }

    const params = parseParams(event, ['uniqueId', 'streamerId'])
    const uniqueId = readUniqueId(params)
    const action = params.action

    if (!isValidUniqueId(uniqueId)) {
      return { code: -1, message: '抖音号不合法', data: null }
    }
    if (!isValidAction(action)) {
      return { code: -1, message: '参数不完整', data: null }
    }

    await ensureCollection(db, COLLECTION)
    const coll = db.collection(COLLECTION)

    if (action === 'follow') {
      await follow(coll, OPENID, uniqueId, params)
      return { code: 0, message: '关注成功', data: { followed: true } }
    }

    await unfollow(coll, OPENID, uniqueId)
    return { code: 0, message: '已取消关注', data: { followed: false } }
  } catch (err) {
    console.error('[toggleFollow] error:', err)
    return { code: -1, message: err.message || '操作失败', data: null }
  }
}
