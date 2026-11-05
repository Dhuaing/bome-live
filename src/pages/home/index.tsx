import React from 'react';
import { View, Text, Image, Button, Swiper, SwiperItem } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro';
import { platformMap } from '@/constants/platform';
import type { Streamer } from '@/types/streamer';
import { formatCount, formatDuration } from '@/utils/time';
import { useStreamerStore } from '@/store/streamer';
import { useFollowsWithStatus } from '@/hooks/useFollowsWithStatus';
import StreamerCard from '@/components/StreamerCard';
import EmptyState from '@/components/EmptyState';
import styles from './index.module.scss';

const HomePage: React.FC = () => {
  const { isFollowed, toggleFollow } = useStreamerStore();
  // 关注列表 + 实时状态，与订阅页同一套真实数据
  const { list: followedStreamers, refresh, loading } = useFollowsWithStatus();
  // 大屏轮播：受控 current——默认对准在播主播，之后交给 autoplay/手势自由转
  const [activeIndex, setActiveIndex] = React.useState(0);

  // 主打卡片：在播优先 > 第一位（决定轮播起点；每屏一个主播，各有按钮）
  const featured: Streamer | undefined =
    followedStreamers.find((s) => s.status === 'living') || followedStreamers[0];

  // 数据就绪/在播集合变化时，把轮播对准在播主播（多人在播时取第一个）
  const livingIds = followedStreamers
    .filter((s) => s.status === 'living')
    .map((s) => s.uniqueId)
    .join(',');
  React.useEffect(() => {
    if (!livingIds) return; // 全员离线不干预，轮播自由转
    const livingIdx = followedStreamers.findIndex((s) => s.status === 'living');
    if (livingIdx >= 0) setActiveIndex(livingIdx);
    //livingIds 已是集合摘要，变化才干预；followedStreamers 为闭包当前值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livingIds]);

  usePullDownRefresh(() => {
    refresh();
    Taro.stopPullDownRefresh();
  });

  useDidShow(() => {
    refresh();
  });

  /** 进入某屏主播的直播间：未开播时给出提示 */
  const handleEnterRoom = (s: Streamer) => {
    if (s.status === 'living' && s.roomUrl) {
      Taro.setClipboardData({
        data: s.roomUrl,
        success: () => Taro.showToast({ title: '直播间链接已复制', icon: 'success' })
      });
    } else {
      Taro.showToast({ title: '主播暂未开播', icon: 'none' });
    }
  };

  const handleViewDetail = (s: Streamer) => {
    Taro.navigateTo({ url: `/pages/streamer-detail/index?id=${s.uniqueId}` });
  };

  const goSubscribe = () => {
    Taro.switchTab({ url: '/pages/subscribe/index' });
  };

  // 加载中：不能直接渲染空态，否则首屏会闪一下"还没有关注的主播"
  if (loading && !featured) {
    return (
      <View className={styles.page}>
        <View className={styles.section}>
          <EmptyState text="加载中…" icon="⏳" />
        </View>
      </View>
    );
  }

  if (!featured) {
    return (
      <View className={styles.page}>
        <View className={styles.section}>
          <EmptyState text="还没有关注的主播，去订阅页输入抖音号添加" icon="🎬" />
        </View>
      </View>
    );
  }

  return (
    <View className={styles.page}>
      <View className={styles.heroSection}>
        <Swiper
          className={styles.heroSwiper}
          current={activeIndex}
          autoplay
          circular
          interval={4500}
          duration={450}
          indicatorDots
          indicatorColor="rgba(255, 255, 255, 0.3)"
          indicatorActiveColor="#ffffff"
          onChange={(e) => setActiveIndex(e.detail.current)}
        >
          {followedStreamers.map((s) => {
            const platform = platformMap[s.platform];
            const platformLabel = s.category ? `${platform.name} · ${s.category}` : platform.name;
            return (
              <SwiperItem key={s.uniqueId}>
                <View
                  className={`${styles.heroCard} ${s.status === 'living' ? styles.heroLiving : styles.heroOffline}`}
                >
                  <View className={styles.heroHeader}>
                    <Image
                      className={styles.heroAvatar}
                      src={s.avatar}
                      mode="aspectFill"
                      onError={() => console.error('[Home] hero avatar load failed:', s.uniqueId)}
                    />
                    <View className={styles.heroInfo}>
                      <Text className={styles.heroName}>{s.name}</Text>
                      <Text
                        className={styles.heroPlatform}
                        style={{ background: platform.color + '30', color: platform.color }}
                      >
                        {platformLabel}
                      </Text>
                    </View>
                  </View>

                  <View className={styles.heroStatus}>
                    {s.status === 'living' ? (
                      <View className={styles.statusLiving}>
                        <View className={styles.liveDot} />
                        <Text>正在直播</Text>
                      </View>
                    ) : (
                      <Text className={styles.statusOffline}>暂未开播</Text>
                    )}
                  </View>

                  {s.status === 'living' ? (
                    <View className={styles.heroRoom}>
                      <Text className={styles.roomTitle}>{s.roomTitle}</Text>
                      <View className={styles.roomMeta}>
                        <Text className={styles.roomMetaItem}>👁 {formatCount(s.viewerCount || 0)} 在线</Text>
                        <Text className={styles.roomMetaItem}>⏱ 已播 {formatDuration(s.liveStartTime || 0)}</Text>
                      </View>
                    </View>
                  ) : (
                    <View className={styles.offlineTip}>
                      <Text>抖音号：{s.uniqueId}</Text>
                    </View>
                  )}

                  <View className={styles.heroActions}>
                    <Button
                      className={styles.primaryBtn}
                      hoverClass={styles.pressed}
                      hoverStayTime={80}
                      onClick={() => handleEnterRoom(s)}
                    >
                      {s.status === 'living' ? '进入直播间' : '开播提醒我'}
                    </Button>
                    <Button
                      className={styles.secondaryBtn}
                      hoverClass={styles.pressed}
                      hoverStayTime={80}
                      onClick={() => handleViewDetail(s)}
                    >
                      详情
                    </Button>
                  </View>
                </View>
              </SwiperItem>
            );
          })}
        </Swiper>
      </View>

      <View className={styles.section}>
        <View className={styles.sectionHeader}>
          <Text className={styles.sectionTitle}>我的订阅</Text>
          <Text className={styles.sectionMore} onClick={goSubscribe}>
            查看全部 ›
          </Text>
        </View>
        {followedStreamers.map((s) => (
          <StreamerCard
            key={s.uniqueId}
            streamer={s}
            isFollowed={isFollowed(s.uniqueId)}
            onFollow={toggleFollow}
          />
        ))}
      </View>
    </View>
  );
};

export default HomePage;