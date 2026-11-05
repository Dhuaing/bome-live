/**
 * 数据层契约（只有接口，没有实现）。
 *
 * 这是「扩展接缝」的核心：业务代码（store / hooks / pages）只依赖这里的接口，
 * 不依赖具体是「本地文件」「云数据库」还是「别人的 REST 后端」。
 *
 * 未来要换后端时，新增一个实现即可，业务代码不动。
 * 详见 docs/扩展接缝设计.md
 */
import type { LiveStatusResult, FollowedStreamer, FollowTarget } from './types';

/** 关注列表的查询结果 */
export interface FollowListResult {
  followedIds: string[];
  streamers: FollowedStreamer[];
}

/** 关注操作的返回 */
export interface FollowActionResult {
  followed: boolean;
}

/**
 * 关注数据仓储。
 *
 * 实现方（当前 / 未来）：
 * - cloudFollowRepository   现在：H5 走 /api，小程序走 Taro.cloud
 * - LocalFollowRepository   未来：localStorage，离线优先
 * - RestFollowRepository    未来：开源后接自建后端
 */
export interface FollowRepository {
  /** 拉取全部关注 */
  list(): Promise<FollowListResult>;
  /** 关注 */
  follow(target: FollowTarget): Promise<FollowActionResult>;
  /** 取关 */
  unfollow(uniqueId: string): Promise<FollowActionResult>;
}

/**
 * 直播状态查询。
 *
 * 实现方：
 * - cloudLiveStatusProvider  现在：云函数抓抖音 SSR
 * - MockLiveStatusProvider   未来：测试用
 */
export interface LiveStatusProvider {
  query(uniqueId: string): Promise<LiveStatusResult>;
}

/**
 * 身份来源。
 *
 * 当前不使用（小程序端 _openid 由平台注入，前端拿不到也不需要），
 * 但记录在这里，说明「数据层不应假设一定存在微信身份」。
 *
 * 未来开源若支持 H5 多用户，需要实现这个接口。
 */
export interface IdentityProvider {
  /** 返回稳定的用户标识 */
  currentUserId(): Promise<string>;
}
