import React, { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useFollowsWithStatus } from '@/hooks/useFollowsWithStatus';
import { fetchHealth, type HealthSummary } from '@/services/health';
import styles from './index.module.scss';

/**
 * 体检徽标文案。
 * undefined = 还在读（首次进入）/ null = 读取失败（按「未知」如实展示，不伪造 ok）
 */
function describeHealth(health: HealthSummary | null | undefined) {
  if (health === undefined) return { dot: '⚪️', text: '巡检状态读取中…', detail: '' };
  if (health === null) return { dot: '⚪️', text: '巡检状态未知', detail: '云端暂不可达' };
  if (health.level === 'ok') {
    const age = health.heartbeatAgeMin == null ? '' : `，最近一轮 ${health.heartbeatAgeMin} 分钟前`;
    return { dot: '🟢', text: '云端巡检正常', detail: `守护者正常${age}` };
  }
  if (health.level === 'warn') {
    return { dot: '🟡', text: '巡检有异常', detail: health.reasons[0] || '' };
  }
  return { dot: '🔴', text: '巡检已停摆', detail: health.reasons[0] || '' };
}

const MinePage: React.FC = () => {
  // 订阅数与直播中数量都来自真实的关注列表 + 实时状态
  const { list } = useFollowsWithStatus();
  const livingCount = list.filter((s) => s.status === 'living').length;

  // 云端体检摘要：把「巡检是不是活着」摆到用户看得见的地方
  // （guardian 曾掉线 18 天没人知道，因为告警只写数据库）
  const [health, setHealth] = useState<HealthSummary | null | undefined>(undefined);
  useDidShow(() => {
    fetchHealth().then(setHealth);
  });

  const healthView = describeHealth(health);

  const handleHealthTap = () => {
    if (!health) return;
    const min = (v: number | null) => (v == null ? '无数据' : `${v} 分钟前`);
    Taro.showModal({
      title: '云端巡检状态',
      content: [
        `分级：${health.level}`,
        `巡检心跳：${min(health.heartbeatAgeMin)}`,
        `守护者自检：${min(health.guardianAgeMin)}`,
        `连续失败：${health.failStreak} 轮`,
        `待处理事故：${health.incidentsOpen} 条`,
        health.reasons.length ? `异常：${health.reasons.join('；')}` : '异常：无'
      ].join('\n'),
      showCancel: false
    });
  };

  const handleMenu = (key: string) => {
    switch (key) {
      case 'notify':
        Taro.switchTab({ url: '/pages/subscribe/index' });
        break;
      case 'about':
        Taro.showModal({
          title: '关于开播喊我',
          content:
            '开播喊我 v1.0.3\n\n实时查询已关注主播的抖音开播状态。\n开播提醒由云端定时巡检，通过微信订阅消息推送到微信。',
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

      <View className={styles.healthBar} hoverClass={styles.healthPressed} hoverStayTime={80} onClick={handleHealthTap}>
        <Text className={styles.healthDot}>{healthView.dot}</Text>
        <View className={styles.healthTextWrap}>
          <Text className={styles.healthText}>{healthView.text}</Text>
          {healthView.detail ? <Text className={styles.healthDetail}>{healthView.detail}</Text> : null}
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
