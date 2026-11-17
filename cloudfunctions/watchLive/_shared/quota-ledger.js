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
 * 写入规则（2026-11-17 健壮性加固，取代旧「读-改-写」三步推演）：
 * 旧实现 read→apply→add/update 整体非原子，并发 earn/spend 交错会丢事件
 * （丢 spend = 虚高，直接违反上面的原则）；且 readQuotaDoc 曾把「读失败」
 * 当「不存在」，瞬时网络抖动会用空账本覆盖真实账本（销毁对账历史）。
 * 现在全部改为数据库端原子操作：
 * - earn ：add 首档（quota=1），冲突则 inc(+1)（inc 服务端原子执行）
 * - spend：where quota>0 条件 inc(-1)——扣不到负（宁虚低）且并发安全；
 *          updated=0 再区分「余额本来就是 0」与「文档不存在」
 * - zero ：无条件把余额写 0（校准不依赖旧值，天然原子）
 * 读规则：不存在返回 null；读失败抛错——绝不能拿空账本覆盖真实账本。
 *
 * 云函数 watchLive 与 notifyQuota 经 sync-cloud-shared.js 拿到副本。
 */

/**
 * 纯函数：按账本事件推演下一份账本字段（不落库）。
 *
 * 保留价值：单测钉死各事件的语义基线；also 作为语义参考——
 * commitEvent 的原子写路径必须与这里的推演结果等价。
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

/** 判断 add 报错是否「_id 已存在」（并发首档创建的冲突信号） */
function isDupKeyError(e) {
  const s = String((e && (e.errCode !== undefined ? e.errCode : e.errMsg)) || (e && e.message) || e);
  return /exists|duplicate|602|duplicate key/i.test(s);
}

/** 判断 get 报错是否「文档不存在」——必须与网络抖动等其他读失败严格区分 */
function isNotExistError(e) {
  const code = e && e.errCode;
  if (code === -502005) return true; // RESOURCE_NOT_FOUND 类
  const s = String((e && (e.errMsg || e.message)) || e);
  return /not exists|not_exist|NOT_FOUND/i.test(s);
}

/**
 * 读账本文档。
 * - 不存在 → null（调用方按空账本语义处理）
 * - 读失败 → 抛错（调用方决定怎么办；绝不能静默当 null 用空账本覆盖）
 */
async function readQuotaDoc(db, collName, openid) {
  try {
    const res = await db.collection(collName).doc(openid).get();
    return (res && res.data && typeof res.data === 'object') ? res.data : null;
  } catch (e) {
    if (isNotExistError(e)) return null;
    throw e;
  }
}

/**
 * 把一个账本事件原子地写入账本。
 *
 * @returns {Promise<{quota,totalEarned,totalSpent,correctedAt?}|null>}
 *          提交后的最新账本读数（提交后回读；读不回时为 null，
 *          调用方按「未知」处理，不伪造数字）
 */
async function commitEvent(db, collName, openid, event) {
  const coll = db.collection(collName);
  const _ = db.command;
  const type = event && event.type;
  const at = (event && event.at) || Date.now();

  /** 提交后回读最新账本；回读失败不回滚提交（原子写已成功），按未知处理 */
  async function readBack() {
    try {
      return await readQuotaDoc(db, collName, openid);
    } catch (e) {
      return null;
    }
  }

  if (type === 'earn') {
    // 首档创建（全新账本 = quota 1）：自定义 _id 直接 add
    try {
      await coll.add({ data: { _id: openid, quota: 1, totalEarned: 1, totalSpent: 0, updatedAt: at } });
      return { quota: 1, totalEarned: 1, totalSpent: 0 };
    } catch (e) {
      if (!isDupKeyError(e)) throw e;
      // 并发下文档已被他人建立 → 退回原子 inc
    }
    await coll.doc(openid).update({
      data: { quota: _.inc(1), totalEarned: _.inc(1), updatedAt: at }
    });
    return await readBack();
  }

  if (type === 'spend') {
    // 条件原子扣减：只在 quota>0 时扣——既防并发双扣，也保证扣不到负（宁虚低）
    const r = await coll
      .where({ _id: openid, quota: _.gt(0) })
      .update({ data: { quota: _.inc(-1), totalSpent: _.inc(1), updatedAt: at } });
    if (r && r.stats && r.stats.updated > 0) return await readBack();

    // updated=0：余额本来就是 0（账本偏低），或文档不存在
    const prev = await readQuotaDoc(db, collName, openid); // 读失败会抛，绝不静默
    if (!prev) {
      // 平台已扣而账本缺失：建档 quota=0、totalSpent=1（宁虚低方向）
      try {
        await coll.add({ data: { _id: openid, quota: 0, totalEarned: 0, totalSpent: 1, updatedAt: at } });
        return { quota: 0, totalEarned: 0, totalSpent: 1 };
      } catch (e) {
        if (!isDupKeyError(e)) throw e;
        // 并发首建冲突 → 退回 inc 累计
      }
    }
    // 余额 0：扣不到负，只记累计推送数（quota 保持 0）
    await coll.doc(openid).update({ data: { totalSpent: _.inc(1), updatedAt: at } });
    return await readBack();
  }

  if (type === 'zero') {
    // 归零校准：不依赖旧值，直接把余额写 0 并留时间戳
    const r = await coll.doc(openid).update({
      data: { quota: 0, correctedAt: at, updatedAt: at }
    });
    if (r && r.stats && r.stats.updated > 0) return await readBack();

    // 文档不存在（doc().update() 对缺失文档是静默空操作，坑 #6）→ add 首档
    try {
      await coll.add({
        data: { _id: openid, quota: 0, totalEarned: 0, totalSpent: 0, correctedAt: at, updatedAt: at }
      });
    } catch (e) {
      if (!isDupKeyError(e)) throw e;
      // 并发首建冲突 → 补一次归零（幂等）
      await coll.doc(openid).update({ data: { quota: 0, correctedAt: at, updatedAt: at } });
    }
    return await readBack();
  }

  throw new Error(`未知账本事件类型: ${type}`);
}

module.exports = { applyLedgerEvent, readQuotaDoc, commitEvent, isDupKeyError };
