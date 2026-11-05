import { useCallback, useRef, useState } from 'react';
import { fetchLiveStatus, invalidateLiveStatus } from '@/services/liveStatusCache';
import type { LiveStatusResult } from '@/services/streamer';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * 单个主播状态的「加载 + 状态机」。
 *
 * 从 useLiveStatus 里抽出，让 hook 只负责编排轮询，
 * 不掺杂 setState / try-catch / 卸载保护这些细节。
 */
export function useStatusLoader(uniqueId: string) {
  const [state, setState] = useState<AsyncState<LiveStatusResult>>({
    data: null,
    loading: true,
    error: null
  });

  const aliveRef = useRef(true);

  /** 标记组件是否仍然挂载（卸载后不再 setState） */
  const markAlive = useCallback((alive: boolean) => {
    aliveRef.current = alive;
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      if (!uniqueId) {
        setState((s) => ({ ...s, loading: false }));
        return;
      }
      if (force) invalidateLiveStatus(uniqueId);
      setState((s) => ({ ...s, loading: true, error: null }));

      try {
        const data = await fetchLiveStatus(uniqueId);
        if (aliveRef.current) setState({ data, loading: false, error: null });
      } catch (e: any) {
        if (!aliveRef.current) return;
        const message = e?.message || '获取直播状态失败';
        setState((s) => ({ ...s, loading: false, error: message }));
        console.error('[useStatusLoader] failed:', e);
      }
    },
    [uniqueId]
  );

  return { ...state, load, markAlive };
}
