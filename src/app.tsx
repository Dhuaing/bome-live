import type { PropsWithChildren } from 'react';
import Taro from '@tarojs/taro';
import { StreamerProvider } from '@/store/streamer';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CLOUD_ENV_ID } from '@/constants/cloud';
import { installErrorReporter } from '@/services/reportError';
// 全局样式
import './app.scss';

function App({ children }: PropsWithChildren) {
  // 云开发初始化已上移到模块加载期（见下方顶层代码）——
  // 若写在这里的 useEffect，React 的子组件 effect 会先执行，
  // StreamerStore 首拉会抢在 init 前跑，关注列表首轮必然空白。
  // ErrorBoundary 包在 Provider 外层：store 自身或页面渲染树上任何
  // 未捕获异常都由它兜底，不再整页白屏。
  return (
    <ErrorBoundary>
      <StreamerProvider>{children}</StreamerProvider>
    </ErrorBoundary>
  );
}

// 模块加载期同步初始化云开发（wx.cloud.init 幂等，早于任何组件 effect）
try {
  Taro.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
} catch (e) {
  console.error('[App] cloud init failed:', e);
}

// 全局异常上报（未捕获错误/未处理 Promise 拒绝 → guardian 云函数落库）
// 与 init 同在模块加载期：越早装越好，能覆盖首屏渲染期的崩溃
try {
  installErrorReporter();
} catch (e) {
  console.error('[App] install error reporter failed:', e);
}

export default App;
