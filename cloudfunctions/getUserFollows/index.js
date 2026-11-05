// 获取当前用户关注列表云函数
//
// 数据模型：云数据库集合 follows，一条记录 = 一个被关注的主播。
// 集合由微信云开发自动注入 _openid 字段，因此天然按用户隔离。
//
// 返回契约（与前端 services/streamer.ts 对齐）：
//   { code: 0, data: { followedIds: string[], streamers: FollowedStreamer[] } }
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'follows'

// 新环境兜底：集合缺失时自建，部署即可用
const { ensureCollection } = require('./_shared/ensure-collection')

/** 云开发单次查询上限 100 条，超出需分页 */
const PAGE_SIZE = 100

/** 拉取当前用户的全部关注记录（自动翻页） */
async function listAllFollows(openid) {
  await ensureCollection(db, COLLECTION)
  const coll = db.collection(COLLECTION)
  const all = []

  let total = 0
  try {
    const countRes = await coll.where({ _openid: openid }).count()
    total = countRes.total || 0
  } catch (e) {
    // count 失败不致命，退化成单页
    console.warn('[getUserFollows] count 失败:', e.message)
  }

  const pages = total > PAGE_SIZE ? Math.ceil(total / PAGE_SIZE) : 1
  for (let i = 0; i < pages; i++) {
    const res = await coll
      .where({ _openid: openid })
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

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) {
      return {
        code: -1,
        message: '未获取到用户身份',
        data: { followedIds: [], streamers: [] }
      }
    }

    const records = await listAllFollows(OPENID)

    // 转成前端期望的结构。_openid / _id 不下发，避免泄露内部标识。
    const streamers = records
      .filter((r) => r && r.uniqueId)
      .map((r) => ({
        id: r.uniqueId,
        uniqueId: r.uniqueId,
        name: r.name || r.uniqueId,
        avatar: r.avatar || '',
        roomUrl: r.roomUrl || `https://live.douyin.com/${r.uniqueId}`,
        platform: r.platform || 'douyin',
        category: r.category || '',
        description: r.description || '',
        status: 'offline',
        createdAt: r.createdAt || 0,
        updatedAt: r.updatedAt || 0
      }))

    return {
      code: 0,
      message: 'success',
      data: {
        followedIds: streamers.map((s) => s.uniqueId),
        streamers
      }
    }
  } catch (err) {
    console.error('[getUserFollows] error:', err)
    return {
      code: -1,
      message: err.message || '获取关注列表失败',
      data: { followedIds: [], streamers: [] }
    }
  }
}
