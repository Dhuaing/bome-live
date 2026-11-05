import React from 'react';
import { View, Image } from '@tarojs/components';
import classnames from 'classnames';
import type { LiveStatus } from '@/types/streamer';
import styles from './index.module.scss';

interface StreamerAvatarProps {
  src: string;
  name: string;
  status: LiveStatus;
  size?: 'sm' | 'md' | 'lg';
}

const StreamerAvatar: React.FC<StreamerAvatarProps> = ({ src, name, status, size = 'md' }) => {
  return (
    <View className={classnames(styles.avatarWrap, styles[size])}>
      <Image
        className={styles.avatar}
        src={src}
        mode="aspectFill"
        onError={() => console.error('[StreamerAvatar] image load failed', name)}
      />
      {status === 'living' && <View className={styles.liveRing} />}
    </View>
  );
};

export default StreamerAvatar;
