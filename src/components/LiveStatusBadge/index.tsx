import React from 'react';
import { View } from '@tarojs/components';
import classnames from 'classnames';
import type { LiveStatus } from '@/types/streamer';
import styles from './index.module.scss';

interface LiveStatusBadgeProps {
  status: LiveStatus;
  size?: 'sm' | 'md';
}

const LiveStatusBadge: React.FC<LiveStatusBadgeProps> = ({ status, size = 'md' }) => {
  const isLiving = status === 'living';
  return (
    <View
      className={classnames(styles.badge, isLiving ? styles.living : styles.offline, size === 'sm' && styles.sm)}
    >
      {isLiving && <View className={styles.dot} />}
      {isLiving ? '直播中' : '未开播'}
    </View>
  );
};

export default LiveStatusBadge;
