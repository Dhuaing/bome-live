import React from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useFollowsWithStatus } from '@/hooks/useFollowsWithStatus';
import styles from './index.module.scss';

const MinePage: React.FC = () => {
  // 订阅数与直播中数量都来自真实的关注列表 + 实时状态
  const { list } = useFollowsWithStatus();
  const livingCount = list.filter((s) => s.status === 'living').length;

  const handleMenu = (key: string) => {
    switch (key) {
      case 'notify':
        Taro.switchTab({ url: '/pages/subscribe/index' });
        break;
      case 'about':
        Taro.showModal({
          title: '关于开播喊我',
          content:
            '开播喊我 v1.0.2\n\n实时查询已关注主播的抖音开播状态。\n开播提醒由云端定时巡检，通过微信订阅消息推送到微信。',
          showCancel: false
        });
        break;
      default:
        break;
    }
  };

  return (
    <View className={styles.page}>
      <View className={styles.profileCard}>
        <View className={styles.stats}>
          <View className={styles.statItem}>
            <Text className={styles.statNum}>{list.length}</Text>
            <Text className={styles.statLabel}>订阅主播</Text>
          </View>
          <View className={styles.statItem}>
            <Text className={styles.statNum}>{livingCount}</Text>
            <Text className={styles.statLabel}>直播中</Text>
          </View>
        </View>
      </View>

      <View className={styles.menuList}>
        <View
          className={styles.menuItem}
          hoverClass={styles.pressed}
          hoverStayTime={80}
          onClick={() => handleMenu('notify')}
        >
          <Text className={styles.menuIcon}>🔔</Text>
          <Text className={styles.menuText}>开播提醒设置</Text>
          <Text className={styles.menuArrow}>›</Text>
        </View>
        <View
          className={styles.menuItem}
          hoverClass={styles.pressed}
          hoverStayTime={80}
          onClick={() => handleMenu('about')}
        >
          <Text className={styles.menuIcon}>ℹ️</Text>
          <Text className={styles.menuText}>关于我们</Text>
          <Text className={styles.menuArrow}>›</Text>
        </View>
      </View>

      <View className={styles.about}>开播喊我 · 实时直播状态查询</View>
    </View>
  );
};

export default MinePage;