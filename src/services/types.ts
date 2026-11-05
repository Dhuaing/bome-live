/**
 * 领域类型定义（纯类型，无运行时依赖）。
 *
 * 拆出来的原因：services/streamer.ts 既导出类型又导出实现，
 * 而 ports.ts 需要引用这些类型，会形成循环。
 * 类型集中在这里，谁都可以引用而不引入运行时依赖。
 */
import type { Streamer } from '@/types/streamer';

/** 直播状态查询结果 */
export interface LiveStatusResult {
  streamerId: string;
  status: 'living' | 'offline';
  roomTitle: string;
  viewerCount: number;
  liveStartTime: number;
  source: string;
  // 云函数 SSR 方案返回的真实字段
  nickname?: string;
  avatar?: string;
  roomUrl?: string;
  roomCover?: string;
  uniqueId?: string;
  roomId?: string;
  likeCount?: number;
}

/** 关注列表里的一条记录（服务端持久化，巡检脚本直接消费） */
export interface FollowedStreamer extends Streamer {
  uniqueId: string;
  createdAt?: number;
  updatedAt?: number;
}

/** 关注时携带的主播快照（昵称头像来自 getStreamerStatus 的真实结果） */
export interface FollowTarget {
  uniqueId?: string;
  name?: string;
  avatar?: string;
  roomUrl?: string;
}
