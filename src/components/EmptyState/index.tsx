import React from 'react';
import { View, Text } from '@tarojs/components';
import styles from './index.module.scss';

interface EmptyStateProps {
  text?: string;
  icon?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ text = '暂无数据', icon = '📭' }) => {
  return (
    <View className={styles.empty}>
      <Text className={styles.icon}>{icon}</Text>
      <Text className={styles.text}>{text}</Text>
    </View>
  );
};

export default EmptyState;
