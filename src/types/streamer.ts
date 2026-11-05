// 主播相关类型定义

export type LiveStatus = 'living' | 'offline';

export type Platform = 'douyin' | 'bilibili' | 'kuaishou' | 'huya';

export interface Streamer {
  id: string;
  name: string;
  avatar: string;
  platform: Platform;
  category: string;
  description: string;
  douyinRoomId?: string; // 抖音直播间 ID
  uniqueId?: string; // 抖音号（即直播间地址 live.douyin.com/{uniqueId}）
  status: LiveStatus;
  // 直播中字段
  roomTitle?: string;
  viewerCount?: number;
  liveStartTime?: number; // 时间戳
  roomCover?: string;
  roomUrl?: string;
  // 离线字段
  lastLiveTime?: number;
  followers?: number;
}

export interface LiveRecord {
  id: string;
  streamerId: string;
  title: string;
  startTime: number;
  duration: number; // 分钟
  viewerCount: number;
}
