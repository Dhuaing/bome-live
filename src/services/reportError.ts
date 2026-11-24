import Taro from '@tarojs/taro';
import { callFunction } from './cloud';
import { RPC } from './rpc';

// 小程序全局 wx（Taro 类型库未透出错误/未处理 Promise 拒绝监听，
// 这里窄声明只用到的方法——与 hooks/usePolling.ts 同一做法）
declare const wx: {
  onError?: (cb: (err: unknown) => void) => void;
  onUnhandledRejection?: (cb: (res: { reason?: unknown }) => void) => void;
};

/**
 * 前端未捕获异常上报（落 watchState 的 cerr__<openid>，入口在 guardian 云函数）。
 *
 * 背景：ErrorBoundary 只负责「不白屏」，错误本身不落地——用户遇到崩溃，
 * 我们没有任何感知渠道。线上问题只能靠用户来抱怨，这是最差的可观测性。
 *
 * 成本约束：这是 fire-and-forget，且做两层节流——
 *   1. 前端 60s 一条（死循环报错不会把调用量刷爆）
 *   2. 服务端 60s 一条/用户（同一用户多端/冷启动也拦得住）
 */

const REPORT_INTERVAL_MS = 60 * 1000;
let lastReportAt = 0;
let installed = false;

/** 当前页面路由：排障时能直接定位到哪个页面崩的 */
function currentRoute(): string {
  try {
    const pages = Taro.getCurrentPages ? Taro.getCurrentPages() : [];
    const last = pages[pages.length - 1] as unknown as { route?: string } | undefined;
    return (last && last.route) || '';
  } catch (e) {
    return '';
  }
}

function normalize(err: unknown): { message: string; stack: string } {
  if (typeof err === 'string') return { message: err, stack: '' };
  const e = err as { message?: string; stack?: string } | null | undefined;
  if (e && typeof e === 'object') {
    return { message: String(e.message || ''), stack: String(e.stack || '') };
  }
  return { message: String(err == null ? '' : err), stack: '' };
}

/** 上报一条前端异常（尽力而为，永不抛错打扰用户） */
export function reportClientError(kind: string, err: unknown): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;

  const { message, stack } = normalize(err);
  callFunction(RPC.guardian, {
    action: 'clientError',
    kind,
    message,
    stack,
    page: currentRoute()
  }).catch(() => {
    // 上报通道自身失败就放弃：不能让上报逻辑再制造一个错误
  });
}

/** 装全局兜底：未捕获错误 + 未处理的 Promise 拒绝 */
export function installErrorReporter(): void {
  if (installed) return;
  installed = true;
  try {
    if (typeof wx === 'undefined') return;
    if (wx.onError) wx.onError((err) => reportClientError('onError', err));
    if (wx.onUnhandledRejection) {
      wx.onUnhandledRejection((res) => reportClientError('unhandledRejection', res && res.reason));
    }
  } catch (e) {
    // 平台不支持该回调时静默降级
  }
}
