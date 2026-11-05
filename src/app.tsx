import type { PropsWithChildren } from 'react';
import Taro from '@tarojs/taro';
import { StreamerProvider } from '@/store/streamer';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CLOUD_ENV_ID } from '@/constants/cloud';
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
if (process.env.TARO_ENV === 'weapp') {
  try {
    Taro.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
  } catch (e) {
    console.error('[App] cloud init failed:', e);
  }
}

export default App;
