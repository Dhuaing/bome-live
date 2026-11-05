import { fetchLiveStatus } from '@/services/liveStatusCache';
import type { LiveStatusResult } from '@/services/streamer';

/**
 * 批量拉取多个主播的直播状态。
 *
 * 从 useFollowsWithStatus 里抽出：
 * - 并发发起，单个失败不影响其他（失败的主播不出现在结果里）
 * - 不抛错，返回「成功的那部分」，调用方据此沿用记录里的旧状态
 */
export async function fetchStatuses(
  uniqueIds: string[]
): Promise<Record<string, LiveStatusResult>> {
  const settled = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        return [id, await fetchLiveStatus(id)] as const;
      } catch (e) {
        console.warn('[Follows] 状态查询失败，沿用记录中的状态:', id, e);
        return null;
      }
    })
  );

  const result: Record<string, LiveStatusResult> = {};
  for (const item of settled) {
    if (item) result[item[0]] = item[1];
  }
  return result;
}
