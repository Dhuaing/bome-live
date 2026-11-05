import { cloudLiveStatusProvider } from '@/services/streamer';
import type { LiveStatusResult } from '@/services/types';

/**
 * 直播状态查询的共享缓存层。
 *
 * 解决的问题：
 * 首页 / 订阅页 / 我的页 / 详情页都会查同一个主播的状态，原先各查各的，
 * 一次进入页面就能对同一 uniqueId 发起多次请求（每个请求在云函数里
 * 又包含「抓抖音首页拿 cookie + 抓直播间页」两次外网请求）。
 *
 * 两层去重：
 * 1. TTL 缓存：30 秒内复用上次结果
 * 2. inflight 合并：同一 uniqueId 的并发请求只发一次
 */

/** 缓存有效期。抖音开播状态变化不需要秒级感知，30 秒足够。 */
export const CACHE_TTL_MS = 30 * 1000;

interface CacheEntry {
  result: LiveStatusResult;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LiveStatusResult>>();

function isFresh(entry?: CacheEntry): boolean {
  return !!entry && Date.now() - entry.at < CACHE_TTL_MS;
}

/**
 * 取某个主播的直播状态，优先走缓存。
 * 失败时不写缓存，异常原样抛给调用方（不伪造数据）。
 */
export function fetchLiveStatus(uniqueId: string): Promise<LiveStatusResult> {
  const cached = cache.get(uniqueId);
  if (isFresh(cached)) {
    return Promise.resolve(cached!.result);
  }

  const pending = inflight.get(uniqueId);
  if (pending) return pending;

  const task = cloudLiveStatusProvider.query(uniqueId)
    .then((result) => {
      cache.set(uniqueId, { result, at: Date.now() });
      return result;
    })
    .finally(() => {
      inflight.delete(uniqueId);
    });

  inflight.set(uniqueId, task);
  return task;
}

/** 主动写入缓存（关注成功后立刻把刚拿到的真实信息写进去，避免闪"未开播"） */
export function primeLiveStatus(uniqueId: string, result: LiveStatusResult): void {
  if (!uniqueId) return;
  cache.set(uniqueId, { result, at: Date.now() });
}

/** 清空全部缓存（下拉刷新 / 手动刷新时用） */
export function clearLiveStatusCache(): void {
  cache.clear();
}

/** 清掉单个主播的缓存 */
export function invalidateLiveStatus(uniqueId: string): void {
  cache.delete(uniqueId);
}
