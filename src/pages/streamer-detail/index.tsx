import React from 'react';
import { View, Text, Image, Button } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import classnames from 'classnames';
import { platformMap } from '@/constants/platform';
import { formatCount, formatDuration } from '@/utils/time';
import { resolveRoomUrl } from '@/utils/followRecord';
import { useStreamerStore } from '@/store/streamer';
import { useLiveStatus } from '@/hooks/useLiveStatus';
import EmptyState from '@/components/EmptyState';
import styles from './index.module.scss';

const StreamerDetailPage: React.FC = () => {
  const router = useRouter();
  // 路由参数 id 就是抖音号（关注记录的 id 与 uniqueId 相同）
  const uniqueId = router.params.id || '';

  const { follows, isFollowed, toggleFollow } = useStreamerStore();
  const record = follows.find((f) => f.uniqueId === uniqueId);

  const { status: liveStatus, loading } = useLiveStatus({ uniqueId, interval: 60000 });

  if (!uniqueId) {
    return (
      <View className={styles.page}>
        <EmptyState text="缺少主播参数" icon="❓" />
      </View>
    );
  }

  const isLiving = liveStatus?.status === 'living';
  const displayName = liveStatus?.nickname || record?.name || uniqueId;
  const displayAvatar = liveStatus?.avatar || record?.avatar || '';
  const displayRoomUrl = resolveRoomUrl(liveStatus?.roomUrl || record?.roomUrl, uniqueId);
  const displayRoomTitle = liveStatus?.roomTitle || '';
  const followed = isFollowed(uniqueId);
  const platform = platformMap.douyin;

  const handleFollow = () => {
    toggleFollow({
      uniqueId,
      name: displayName,
      avatar: displayAvatar,
      roomUrl: displayRoomUrl
    });
  };

  const handleCopyRoom = () => {
    Taro.setClipboardData({
      data: displayRoomUrl,
      success: () => Taro.showToast({ title: '直播间链接已复制', icon: 'success' })
    });
  };

  return (
    <View className={styles.page}>
      <View className={styles.header}>
        <Image
          className={styles.avatar}
          src={displayAvatar}
          mode="aspectFill"
          onError={() => console.error('[Detail] avatar load failed')}
        />
        <View className={styles.info}>
          <Text className={styles.name}>{displayName}</Text>
          <View className={styles.platformRow}>
            <Text
              className={styles.platformTag}
              style={{ background: platform.color + '15', color: platform.color }}
            >
              {platform.name}
            </Text>
            <Text className={styles.category}>抖音号 {uniqueId}</Text>
          </View>
        </View>
        <Button
          className={classnames(styles.followBtn, followed && styles.followed)}
          hoverClass={styles.pressed}
          hoverStayTime={80}
          onClick={handleFollow}
        >
          {followed ? '已关注' : '+ 关注'}
        </Button>
      </View>

      <View className={classnames(styles.liveCard, isLiving && styles.liveCardLiving)}>
        <View className={styles.liveCardContent}>
          {isLiving ? (
            <>
              <View className={styles.statusRow}>
                <View className={styles.liveDot} />
                <Text className={styles.statusText}>正在直播 {loading ? '(刷新中...)' : ''}</Text>
              </View>
              <Text className={styles.roomTitle}>{displayRoomTitle}</Text>
              <View className={styles.roomMeta}>
                <Text className={styles.metaItem}>👁 {formatCount(liveStatus?.viewerCount || 0)}</Text>
                <Text className={styles.metaItem}>⏱ {formatDuration(liveStatus?.liveStartTime || 0)}</Text>
              </View>
              <Button className={styles.enterBtn} hoverClass={styles.pressed} hoverStayTime={80} onClick={handleCopyRoom}>
                进入直播间
              </Button>
            </>
          ) : (
            <>
              <Text className={styles.offlineStatus}>暂未开播 {loading ? '(检测中...)' : ''}</Text>
              {displayRoomTitle ? (
                <Text className={styles.roomTitle}>最近直播间：{displayRoomTitle}</Text>
              ) : null}
              <Button className={styles.offlineBtn} hoverClass={styles.pressed} hoverStayTime={80} onClick={handleCopyRoom}>
                复制直播间地址
              </Button>
            </>
          )}
        </View>
      </View>

      <View className={styles.description}>
        <Text className={styles.descTitle}>主播信息</Text>
        <Text className={styles.descContent}>
          {displayName}
          {'\n'}抖音号：{uniqueId}
          {'\n'}直播间：{displayRoomUrl}
        </Text>
      </View>
    </View>
  );
};

export default StreamerDetailPage;