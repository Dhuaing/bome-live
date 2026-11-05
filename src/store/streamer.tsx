import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import Taro from '@tarojs/taro';
import { cloudFollowRepository } from '@/services/streamer';
import type { FollowTarget, FollowedStreamer } from '@/services/streamer';
import { isValidUniqueId, buildFollowRecord } from '@/utils/followRecord';

interface StreamerStore {
  /** 关注的主播完整记录（服务端持久化） */
  follows: FollowedStreamer[];
  /** 正在关注的主播抖音号 */
  followedIds: string[];
  loading: boolean;
  isFollowed: (uniqueId?: string) => boolean;
  toggleFollow: (target: FollowTarget) => Promise<void>;
  refreshFollows: () => Promise<void>;
}

const StreamerContext = createContext<StreamerStore | null>(null);

/** in-flight 锁：同一主播上一次请求未完成时忽略重复点击（防并发双插/竞态回滚错乱） */
const pendingFollows = new Set<string>();

export const StreamerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [follows, setFollows] = useState<FollowedStreamer[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  // 初始为 true：首帧还没拉到数据，不应被当成"确实没有关注"
  const [loading, setLoading] = useState(true);

  const refreshFollows = useCallback(async () => {
    setLoading(true);
    try {
      // 通过 FollowRepository 接口访问，不直接依赖云函数
      const res = await cloudFollowRepository.list();
      setFollows(res.streamers);
      setFollowedIds(res.followedIds);
    } catch (e: any) {
      console.error('[StreamerStore] refreshFollows failed:', e);
      Taro.showToast({ title: e?.message || '获取关注列表失败', icon: 'none' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshFollows();
  }, [refreshFollows]);

  const isFollowed = useCallback(
    (uniqueId?: string) => !!uniqueId && followedIds.includes(uniqueId),
    [followedIds]
  );

  const toggleFollow = useCallback(
    async (target: FollowTarget) => {
      const uniqueId = String(target?.uniqueId || '').trim();
      if (!isValidUniqueId(uniqueId)) {
        Taro.showToast({ title: '该主播未接入抖音号', icon: 'none' });
        return;
      }
      // in-flight 去重：同一主播请求没回来之前，重复点击直接忽略
      // （防网络慢时双击 → 两路并发请求 → 云端 findExisting 读-写窗口双插）
      if (pendingFollows.has(uniqueId)) return;
      pendingFollows.add(uniqueId);

      const action = followedIds.includes(uniqueId) ? 'unfollow' : 'follow';
      const prevFollows = follows;
      const prevIds = followedIds;

      // 乐观更新：记录结构由 buildFollowRecord 统一构造，
      // 与 H5 服务端、云函数使用同一套规则
      if (action === 'follow') {
        setFollowedIds([...prevIds, uniqueId]);
        setFollows((prev) =>
          prev.some((f) => f.uniqueId === uniqueId)
            ? prev
            : [
                ...prev,
                buildFollowRecord({ ...target, uniqueId }, null) as FollowedStreamer
              ]
        );
      } else {
        setFollowedIds(prevIds.filter((x) => x !== uniqueId));
        setFollows((prev) => prev.filter((f) => f.uniqueId !== uniqueId));
      }

      try {
        // 通过 FollowRepository 接口，区分 follow / unfollow 两个动作
        if (action === 'follow') {
          await cloudFollowRepository.follow(target);
        } else {
          await cloudFollowRepository.unfollow(uniqueId);
        }
      } catch (e: any) {
        console.error('[StreamerStore] toggleFollow failed:', e);
        // 回滚
        setFollowedIds(prevIds);
        setFollows(prevFollows);
        Taro.showToast({ title: e?.message || '操作失败', icon: 'none' });
      } finally {
        pendingFollows.delete(uniqueId);
      }
    },
    [followedIds, follows]
  );

  return (
    <StreamerContext.Provider value={{ follows, followedIds, loading, isFollowed, toggleFollow, refreshFollows }}>
      {children}
    </StreamerContext.Provider>
  );
};

export const useStreamerStore = (): StreamerStore => {
  const ctx = useContext(StreamerContext);
  if (!ctx) {
    throw new Error('useStreamerStore must be used within StreamerProvider');
  }
  return ctx;
};