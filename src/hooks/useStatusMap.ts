import { useCallback, useMemo, useRef, useState } from 'react';
import { clearLiveStatusCache, primeLiveStatus } from '@/services/liveStatusCache';
import { fetchStatuses } from './fetchStatuses';
import type { LiveStatusResult } from '@/services/streamer';

interface UseStatusMapResult {
  statuses: Record<string, LiveStatusResult>;
  loading: boolean;
  /** 拉取一批 uniqueId 的状态；silent=true 不闪 loading */
  load: (silent: boolean) => Promise<void>;
  /** 写入单个主播的最新状态（缓存 + state 同步） */
  setOne: (uniqueId: string, result: LiveStatusResult) => void;
  /** 手动刷新：清缓存并让调用方重拉 */
  requestRefresh: () => void;
  /** 外部刷新信号，交给 usePolling 的 refreshKey */
  refreshKey: number;
  /** 是否至少完成过一轮加载 */
  hasLoaded: boolean;
}

/**
 * 多主播状态的「状态表」管理。
 *
 * 从 useFollowsWithStatus 里抽出：
 * 这个 hook 只关心「一堆 uniqueId 的状态映射 + loading + 刷新」，
 * 不关心关注列表从哪来、也不关心列表怎么排序渲染。
 */
export function useStatusMap(uniqueIdsKey: string): UseStatusMapResult {
  const [statuses, setStatuses] = useState<Record<string, LiveStatusResult>>({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // 首轮是否完成：用于忽略挂载瞬间造成的重复请求
  const loadedRef = useRef(false);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      const ids = uniqueIdsKey ? uniqueIdsKey.split(',') : [];
      setStatuses(await fetchStatuses(ids));
      setLoading(false);
      loadedRef.current = true;
    },
    [uniqueIdsKey]
  );

  const setOne = useCallback((uniqueId: string, result: LiveStatusResult) => {
    primeLiveStatus(uniqueId, result);
    setStatuses((prev) => ({ ...prev, [uniqueId]: result }));
  }, []);

  const requestRefresh = useCallback(() => {
    if (!loadedRef.current) return; // 首轮未完成，忽略
    clearLiveStatusCache();
    setRefreshKey((t) => t + 1);
  }, []);

  return useMemo(
    () => ({
      statuses,
      loading,
      load,
      setOne,
      requestRefresh,
      refreshKey,
      hasLoaded: loadedRef.current
    }),
    [statuses, loading, load, setOne, requestRefresh, refreshKey]
  );
}
