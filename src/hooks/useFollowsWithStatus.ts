import { useMemo } from 'react';
import { useStreamerStore } from '@/store/streamer';
import { mergeStreamerList, toUniqueIds } from './streamerMerge';
import { useStatusMap } from './useStatusMap';
import { usePolling } from './usePolling';
import type { LiveStatusResult } from '@/services/streamer';
import type { Streamer } from '@/types/streamer';

interface UseFollowsWithStatusResult {
  list: Streamer[];
  statuses: Record<string, LiveStatusResult>;
  /** 关注成功后写入刚拿到的真实状态，避免新卡片闪"未开播" */
  setStatus: (uniqueId: string, result: LiveStatusResult) => void;
  refresh: () => void;
  loading: boolean;
}

/**
 * 关注列表（服务端持久化）+ 实时开播状态，合并成可直接渲染的列表。
 * 订阅页 / 首页 / 我的页共用。
 *
 * 只做编排：
 * - 关注列表来自 store
 * - 状态表与刷新委托给 useStatusMap
 * - 轮询委托给 usePolling
 * - 合并排序委托给 streamerMerge
 */
export function useFollowsWithStatus(interval = 60000): UseFollowsWithStatusResult {
  const { follows, loading: followsLoading } = useStreamerStore();

  // 用字符串做依赖，避免数组引用变化导致反复拉取
  const uniqueIdsKey = useMemo(() => toUniqueIds(follows).join(','), [follows]);

  const { statuses, loading: statusLoading, load, setOne, requestRefresh, refreshKey } =
    useStatusMap(uniqueIdsKey);

  usePolling({ interval, task: load, refreshKey });

  const list = useMemo(() => mergeStreamerList(follows, statuses), [follows, statuses]);

  return {
    list,
    statuses,
    setStatus: setOne,
    refresh: requestRefresh,
    loading: followsLoading || statusLoading
  };
}
