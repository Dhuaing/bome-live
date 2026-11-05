import { useEffect } from 'react';
import { usePolling } from './usePolling';
import { useStatusLoader } from './useStatusLoader';

interface UseLiveStatusOptions {
  /** 抖音号（唯一标识，关注记录的 id 与它相同） */
  uniqueId: string;
  autoFetch?: boolean;
  interval?: number; // 轮询间隔(ms)，0 表示不轮询
}

interface UseLiveStatusResult {
  status: ReturnType<typeof useStatusLoader>['data'];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * 查询单个主播的实时直播状态，支持轮询。
 * 走 services/liveStatusCache 的共享缓存，与列表页共用同一份结果。
 * 查询失败不回退 mock，保留上一次结果并记录 error。
 *
 * 职责划分：
 * - useStatusLoader：加载 + 状态机 + 卸载保护
 * - usePolling：轮询节奏
 * - 本 hook：只做编排
 */
export function useLiveStatus({
  uniqueId,
  autoFetch = true,
  interval = 0
}: UseLiveStatusOptions): UseLiveStatusResult {
  const { data, loading, error, load, markAlive } = useStatusLoader(uniqueId);

  // 卸载后不再 setState
  useEffect(() => {
    markAlive(true);
    return () => markAlive(false);
  }, [markAlive]);

  usePolling({
    interval: autoFetch ? interval : 0,
    enabled: autoFetch,
    // 首轮走缓存，后续轮次强制刷新
    task: (silent) => load(!silent)
  });

  return { status: data, loading, error, refresh: () => load(true) };
}
