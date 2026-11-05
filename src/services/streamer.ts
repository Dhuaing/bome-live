import { callFunction } from './cloud';
import { RPC } from './rpc';
import type {
  FollowRepository,
  FollowListResult,
  FollowActionResult,
  LiveStatusProvider
} from './ports';
import type { LiveStatusResult, FollowTarget } from './types';

// 统一从 services/types 转出，调用方仍可 `from '@/services/streamer'` 取类型
export type { LiveStatusResult, FollowedStreamer, FollowTarget } from './types';
export type { FollowRepository, FollowListResult, FollowActionResult, LiveStatusProvider } from './ports';

/**
 * 把后端返回归一化成领域对象。
 *
 * 后端换实现（云函数 → REST → 其他）时，只改这里，
 * 业务代码拿到的结构始终一致。
 */
function toFollowList(raw: any): FollowListResult {
  const streamers = Array.isArray(raw?.streamers) ? raw.streamers : [];
  const followedIds = Array.isArray(raw?.followedIds)
    ? raw.followedIds
    : streamers.map((s: any) => s.uniqueId).filter(Boolean);

  return { followedIds, streamers };
}

function toFollowResult(raw: any): FollowActionResult {
  return { followed: raw?.followed === true };
}

/**
 * 云函数实现：H5 走 /api 网关，小程序走 Taro.cloud。
 *
 * 传输层差异由 services/cloud.ts 吸收，这里只关心「调哪个方法、怎么归一化」。
 */
export const cloudFollowRepository: FollowRepository = {
  async list() {
    return toFollowList(await callFunction(RPC.getUserFollows, {}));
  },

  async follow(target: FollowTarget) {
    return toFollowResult(await callFunction(RPC.toggleFollow, { ...target, action: 'follow' }));
  },

  async unfollow(uniqueId: string) {
    return toFollowResult(
      await callFunction(RPC.toggleFollow, { uniqueId, action: 'unfollow' })
    );
  }
};

/** 云函数实现：直播状态查询 */
export const cloudLiveStatusProvider: LiveStatusProvider = {
  async query(uniqueId: string) {
    return callFunction<LiveStatusResult>(RPC.getStreamerStatus, { uniqueId });
  }
};

// ── 旧函数式导出（保留以平滑迁移，新代码请用上面的 repository）──

/** @deprecated 用 cloudLiveStatusProvider.query */
export async function getStreamerStatus(params: {
  uniqueId?: string;
}): Promise<LiveStatusResult> {
  return callFunction<LiveStatusResult>(RPC.getStreamerStatus, params);
}

/** @deprecated 用 cloudFollowRepository.follow / unfollow */
export async function toggleFollow(
  target: FollowTarget,
  action: 'follow' | 'unfollow'
): Promise<FollowActionResult> {
  return toFollowResult(await callFunction(RPC.toggleFollow, { ...target, action }));
}

/** @deprecated 用 cloudFollowRepository.list */
export async function getUserFollows(): Promise<FollowListResult> {
  return toFollowList(await callFunction(RPC.getUserFollows, {}));
}
