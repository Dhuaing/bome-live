import React from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import type { Streamer } from '@/types/streamer';
import { platformMap } from '@/constants/platform';
import { formatCount, formatDuration } from '@/utils/time';
import StreamerAvatar from '@/components/StreamerAvatar';
import LiveStatusBadge from '@/components/LiveStatusBadge';
import styles from './index.module.scss';

interface StreamerCardProps {
  streamer: Streamer;
  isFollowed: boolean;
  onFollow: (streamer: Streamer) => void;
}

const StreamerCard: React.FC<StreamerCardProps> = ({ streamer, isFollowed, onFollow }) => {
  const platform = platformMap[streamer.platform];

  const handleCardClick = () => {
    Taro.navigateTo({ url: `/pages/streamer-detail/index?id=${streamer.id}` });
  };

  const handleFollow = (e: any) => {
    e.stopPropagation();
    onFollow(streamer);
  };

  return (
    <View className={styles.card} onClick={handleCardClick}>
      <StreamerAvatar src={streamer.avatar} name={streamer.name} status={streamer.status} size="md" />
      <View className={styles.info}>
        <View className={styles.topRow}>
          <Text className={styles.name}>{streamer.name}</Text>
          <LiveStatusBadge status={streamer.status} size="sm" />
        </View>
        {streamer.status === 'living' ? (
          <View className={styles.liveInfo}>
            <Text className={styles.roomTitle}>{streamer.roomTitle}</Text>
            <View className={styles.meta}>
              <Text className={styles.metaItem}>👁 {formatCount(streamer.viewerCount || 0)}</Text>
              <Text className={styles.metaItem}>⏱ {formatDuration(streamer.liveStartTime || 0)}</Text>
            </View>
          </View>
        ) : (
          <View className={styles.offlineInfo}>
            <Text className={styles.desc}>{streamer.description}</Text>
          </View>
        )}
        <View className={styles.bottomRow}>
          <View className={styles.platformTag} style={{ background: platform.color + '15', color: platform.color }}>
            {platform.name}
          </View>
          <Text className={styles.category}>{streamer.category}</Text>
        </View>
      </View>
      <View
        className={classnames(styles.followBtn, isFollowed && styles.followed)}
        hoverClass={styles.pressed}
        hoverStayTime={80}
        onClick={handleFollow}
      >
        {isFollowed ? '已关注' : '+ 关注'}
      </View>
    </View>
  );
};

export default StreamerCard;
