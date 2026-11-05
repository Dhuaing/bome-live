import type { LiveStatusResult, FollowedStreamer } from '@/services/streamer';
import type { Streamer } from '@/types/streamer';

/**
 * 把「关注记录 + 实时状态」合并成可直接渲染的 Streamer。
 *
 * 从 useFollowsWithStatus 里抽出来的纯函数：
 * 不依赖 React，可单独测试，也让 hook 本身只剩编排逻辑。
 */
export function mergeStreamer(
  follow: FollowedStreamer,
  status?: LiveStatusResult
): Streamer {
  return {
    ...follow,
    name: status?.nickname || follow.name || follow.uniqueId,
    avatar: status?.avatar || follow.avatar || '',
    status: status?.status || 'offline',
    roomTitle: status?.roomTitle || '',
    viewerCount: status?.viewerCount || 0,
    liveStartTime: status?.liveStartTime || 0,
    roomUrl: status?.roomUrl || follow.roomUrl,
    category: follow.category || '',
    description: follow.description || `抖音号 ${follow.uniqueId}`
  };
}

/** 在播的排前面；比较器必须返回三值之一 */
function livingFirst(a: Streamer, b: Streamer): number {
  const rank = (s: Streamer) => (s.status === 'living' ? 0 : 1);
  return rank(a) - rank(b);
}

/** 批量合并并排序 */
export function mergeStreamerList(
  follows: FollowedStreamer[],
  statuses: Record<string, LiveStatusResult>
): Streamer[] {
  return follows.map((f) => mergeStreamer(f, statuses[f.uniqueId])).sort(livingFirst);
}

/** 关注列表 → 稳定的 uniqueId 数组（排序保证依赖比较时不会反复变化） */
export function toUniqueIds(follows: FollowedStreamer[]): string[] {
  return follows
    .map((f) => f.uniqueId)
    .filter(Boolean)
    .sort();
}
