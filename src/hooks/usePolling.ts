import { useEffect, useRef } from 'react';

// 小程序全局 wx（Taro 类型库未透出 App 级 hide/show 监听，这里窄声明只用到的四个方法）
declare const wx: {
  onAppHide: (cb: () => void) => void;
  offAppHide: (cb: () => void) => void;
  onAppShow: (cb: () => void) => void;
  offAppShow: (cb: () => void) => void;
};

interface UsePollingOptions {
  /** 轮询间隔(ms)；0 或负数表示只拉首次 */
  interval: number;
  /** 是否启用 */
  enabled?: boolean;
  /**
   * 每次执行的函数。
   * silent=true 表示后台轮询（不引起数据飞速亮度/ loading）。
   *
   * 注意：task 的「前后切换」会触发重连（如现场 render 会重新传 task），
   * 但不会触发一个立即执行——除首挂外的手动刷新走 refreshKey。
   */
  task: (silent: boolean) => void | Promise<void>;
  /** 外部变化时触发一次重取（外部 refreshKey 变化的手动刷新） */
  refreshKey?: unknown;
}

/**
 * 通用轮询：先拉一次，之后按间隔重复，直到清理。
 *
 * 后台感知（健壮性）：App 整体切到后台（home 键/切走微信）时，页面钩子
 * 不会触发——轮询器还在空转烧云函数调用与电量。这里：
 *   - onHide 置暂停位（周期任务静默跳过）
 *   - onShow 自动补拉一轮静默刷新，回到前台数据立即对齐
 * 小程序走 wx.onAppHide/onAppShow；H5 走 visibilitychange。
 */
export function usePolling({
  interval,
  enabled = true,
  task,
  refreshKey
}: UsePollingOptions): void {
  const taskRef = useRef(task);
  taskRef.current = task;

  const pausedRef = useRef(false);

  // 主循环只在 interval / enabled 变化时重建
  useEffect(() => {
    if (!enabled) return;

    taskRef.current(false);

    if (interval <= 0) return;

    const timer = setInterval(() => {
      if (pausedRef.current) return; // 后台静默跳过（不积压不重复）
      taskRef.current(true);
    }, interval);

    return () => clearInterval(timer);
  }, [interval, enabled]);

  // 前后台感知：hide 暂停 · show 补拉
  useEffect(() => {
    if (!enabled) return;
    let cleanup = () => {};

    if (process.env.TARO_ENV === 'weapp') {
      const onHide = () => { pausedRef.current = true; };
      const onShow = () => {
        if (!pausedRef.current) return; // 常规 tab 切换不触发 App 级 show
        pausedRef.current = false;
        taskRef.current(true); // 静默补拉，避免 loading 闪烁
      };
      wx.onAppHide(onHide);
      wx.onAppShow(onShow);
      cleanup = () => {
        try { wx.offAppHide(onHide); } catch (e) { /* 老基础库无 off 版本时忽略 */ }
        try { wx.offAppShow(onShow); } catch (e) { /* 同上 */ }
      };
    } else {
      const onVisibility = () => {
        const hidden = document.visibilityState === 'hidden';
        if (hidden) {
          pausedRef.current = true;
        } else if (pausedRef.current) {
          pausedRef.current = false;
          taskRef.current(true);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      cleanup = () => document.removeEventListener('visibilitychange', onVisibility);
    }

    return cleanup;
  }, [enabled]);

  // 外部要求刷新：只补拉一次（不重置计时器）
  const firstRefreshRef = useRef(true);
  useEffect(() => {
    if (firstRefreshRef.current) {
      firstRefreshRef.current = false;
      return; // 挂载时主循环已能拉动
    }
    if (!enabled) return;
    taskRef.current(false);
  }, [refreshKey, enabled]);
}
