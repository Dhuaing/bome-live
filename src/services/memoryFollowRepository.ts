/**
 * 接缝验证：内存版 FollowRepository。
 *
 * 这个文件存在的唯一目的，是证明「换一个数据实现不需要改业务代码」。
 * 它没有接进产品，只在测试里用。
 *
 * 如果未来要加 LocalFollowRepository / RestFollowRepository，
 * 照这个形状写即可，store / hooks / pages 一行都不用改。
 */
import type {
  FollowRepository,
  FollowListResult,
  FollowActionResult
} from '@/services/ports';
import type { FollowedStreamer, FollowTarget } from '@/services/types';
import { buildFollowRecord } from '@/utils/followRecord';

/** 创建一个内存仓储（供测试或未来离线模式使用） */
export function createMemoryFollowRepository(
  seed: FollowedStreamer[] = []
): FollowRepository & { snapshot(): FollowedStreamer[] } {
  let items: FollowedStreamer[] = [...seed];

  return {
    async list(): Promise<FollowListResult> {
      return {
        followedIds: items.map((i) => i.uniqueId),
        streamers: [...items]
      };
    },

    async follow(target: FollowTarget): Promise<FollowActionResult> {
      const uniqueId = String(target?.uniqueId || '').trim();
      const existing = items.find((i) => i.uniqueId === uniqueId) || null;
      const record = buildFollowRecord({ ...target, uniqueId }, existing) as FollowedStreamer;

      items = existing
        ? items.map((i) => (i.uniqueId === uniqueId ? record : i))
        : [...items, record];

      return { followed: true };
    },

    async unfollow(uniqueId: string): Promise<FollowActionResult> {
      items = items.filter((i) => i.uniqueId !== uniqueId);
      return { followed: false };
    },

    /** 测试用：读当前内容 */
    snapshot() {
      return [...items];
    }
  };
}
