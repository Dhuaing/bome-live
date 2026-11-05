/**
 * 订阅消息额度账本（自建，因为微信没有「查询剩余额度」的 API）。
 *
 * 模型：微信侧一次性订阅额度是黑盒，只能行为级推断——
 * - earn  ：前端 requestSubscribeMessage 收到 accept 时 +1（额度 +
 *           是平台行为，账本仅记录）
 * - spend ：云端 subscribeMessage.send 成功时 -1（推送一次消费一条，
 *           平台已扣，账本同步）
 * - zero  ：云端 send 返回 43101（用户没额度）时归零校准——账本必然
 *           在某处漏记了消费（手动消耗/其他设备），以平台的回答为准
 *
 * 展示永远允许「虚低」不允许「虚高」：spend 扣不到负数，zero 兜底，
 * 用户看到的数字只会保守。错误方向是「显示 0 但其实有」，代价只是
 * 用户多点一次「开启」——不像虚高会让他白等提醒。
 *
 * IO 规则沿用 watchState 的教训（坑 #6）：doc().update() 对不存在
 * 文档是静默空操作——先读后写（add 带自定义 _id，冲突时回退 update）。
 *
 * 云函数 watchLive 与 notifyQuota 经 sync-cloud-shared.js 拿到副本。
 */

/**
 * 纯函数：按账本事件推演下一份账本字段（不落库）。
 *
 * @param {object|undefined} doc 现有账本文档（无则视为全新）
 * @param {{type: 'earn'|'spend'|'zero', at?: number}} event
 * @returns {{quota: number, totalEarned: number, totalSpent: number, correctedAt?: number}}
 */
function applyLedgerEvent(doc, event) {
  const quota = doc && Number(doc.quota) > 0 ? Math.floor(Number(doc.quota)) : 0;
  const totalEarned = doc && doc.totalEarned > 0 ? Math.floor(doc.totalEarned) : 0;
  const totalSpent = doc && doc.totalSpent > 0 ? Math.floor(doc.totalSpent) : 0;
  const type = event && event.type;

  if (!Number.isFinite(quota) || !Number.isFinite(totalEarned) || !Number.isFinite(totalSpent)) {
    return { quota: 0, totalEarned: 0, totalSpent: 0, correctedAt: event && event.at || Date.now() };
  }

  switch (type) {
    case 'earn':
      return { quota: quota + 1, totalEarned: totalEarned + 1, totalSpent };
    case 'spend':
      // 余额扣到 0 为下限：账本偏低时扣减不减为负（平台永远 >= 账本）
      return { quota: Math.max(quota - 1, 0), totalEarned, totalSpent: totalSpent + 1 };
    case 'zero':
      // 平台说没额度 → 账本虚高必须归零，并留下校准时间戳
      return { quota: 0, totalEarned, totalSpent, correctedAt: event.at || Date.now() };
    default:
      // 未知事件不动账本
      return { quota, totalEarned, totalSpent };
  }
}

/** 读账本（不存在返回 { quota: 0, totalEarned: 0, totalSpent: 0 }） */
async function readQuotaDoc(db, collName, openid) {
  try {
    const res = await db.collection(collName).doc(openid).get();
    return (res && res.data && typeof res.data === 'object') ? res.data : null;
  } catch (e) {
    return null; // 文档不存在或网络抖动，按空账本处理
  }
}

/**
 * 读后写地把一个事件应用进账本（自动处理首档创建与并发冲突）。
 * @returns {{quota, totalEarned, totalSpent, correctedAt?}} 最新账本
 */
async function commitEvent(db, collName, openid, event) {
  const coll = db.collection(collName);
  const prev = await readQuotaDoc(db, collName, openid);
  const next = applyLedgerEvent(prev, event);
  const patch = { ...next, updatedAt: event && event.at || Date.now() };

  if (!prev) {
    try {
      await coll.add({ data: { _id: openid, ...patch } });
      return next;
    } catch (e) {
      // 并发下文档已被他人建立 → 退回 update 覆盖为最新推演值
      if (!/exists|602|duplicate/i.test(String(e.errCode || e.errMsg || e.message))) throw e;
    }
  }
  await coll.doc(openid).update({ data: patch });
  return next;
}

module.exports = { applyLedgerEvent, readQuotaDoc, commitEvent };
