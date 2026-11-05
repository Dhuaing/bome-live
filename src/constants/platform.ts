import type { Platform } from '@/types/streamer';

/** 平台展示名与主题色（纯展示配置，不是数据源） */
export const platformMap: Record<Platform, { name: string; color: string }> = {
  douyin: { name: '抖音', color: '#000000' },
  bilibili: { name: 'B站', color: '#FB7299' },
  kuaishou: { name: '快手', color: '#FF4906' },
  huya: { name: '虎牙', color: '#FF6600' }
};