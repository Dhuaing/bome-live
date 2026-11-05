/**
 * 订阅额度可视化服务（微信没有「查询剩余额度」API，靠云端自建账本）。
 *
 * 账本模型（云端 subsQuota 集合，docId = openid，见 _shared/quota-ledger.js）：
 * - 每次收到一次「允许」（requestSubscribeMessage accept）→ earn（+1）
 * - 云端推送成功 → spend（-1）；平台回 43101 → zero（归零校准）
 * - 展示原则宁虚低不虚高：显示 0 但实际有 → 用户多点一次「开启」而已
 */
import { callFunction } from './cloud';
import { RPC } from './rpc';

export interface QuotaInfo {
  /** 预估剩余可推送条数 */
  quota: number;
  /** 累计攒过的条数 */
  totalEarned: number;
  /** 累计已推送条数 */
  totalSpent: number;
  /** 最近一次因 43101 归零校准的时间戳（0 = 从未校准过） */
  correctedAt: number;
}

/** 读当前用户额度账本；失败返回 null（UI 按「未知」处理，不随便显示 0） */
export async function getQuota(): Promise<QuotaInfo | null> {
  try {
    return await callFunction<QuotaInfo>(RPC.notifyQuota, { action: 'get' });
  } catch (e) {
    console.warn('[notifyQuota] 读取账本失败:', e);
    return null;
  }
}

/** 攒额度后回写账本（每次 accept 精确调用一次）；失败静默，不影响订阅主流程 */
export async function earnQuota(): Promise<QuotaInfo | null> {
  try {
    return await callFunction<QuotaInfo>(RPC.notifyQuota, { action: 'earn' });
  } catch (e) {
    console.warn('[notifyQuota] 账本 +1 失败:', e);
    return null;
  }
}
