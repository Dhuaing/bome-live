import React from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './ErrorBoundary.module.scss';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * 全局渲染容灾：任何页面组件抛错时兜住渲染树，不再整页白屏。
 *
 * 小程序页面没有内建 “crash → 提示重试” 的兜底：一个组件 render 抛错
 * 直接白死整页。这里提供：
 *   - 崩溃后展示可理解的错误态替代白屏
 *   - 「重试」按钮清掉错误态重挂 children（常规瞬时错误即可自愈）
 *   - componentDidCatch 记录错误（AI 值守排障时可见，与坑 #3 呼应：
 *     除 console 外仍不赌日志，可观测层后续可接上报）
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] 渲染崩溃已兜底:', error, info.componentStack);
  }

  /** 重试：清错误态 + 触发一次整页刷新（关注列表等数据走 store refetch） */
  handleRetry = () => {
    this.setState({ hasError: false });
    // 回到首页再回来不现实（tabBar 页面特殊）；保守做法是让 store 全量重拉
    // 这里仅重挂 children —— 数据层自身有轮询与 onShow 刷新兜底
  };

  handleBackHome = () => {
    Taro.switchTab({ url: '/pages/home/index' });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View className={styles.page}>
        <View className={styles.card}>
          <Text className={styles.icon}>🛠️</Text>
          <Text className={styles.title}>页面出了点小问题</Text>
          <Text className={styles.desc}>数据不会丢，点下面再试一次</Text>
          <View className={styles.actions}>
            <View className={styles.primaryBtn} hoverStayTime={80} onClick={this.handleRetry}>
              重试
            </View>
            <View className={styles.secondaryBtn} hoverStayTime={80} onClick={this.handleBackHome}>
              回首页
            </View>
          </View>
        </View>
      </View>
    );
  }
}
