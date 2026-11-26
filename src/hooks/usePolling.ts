import { useCallback, useEffect, useRef } from 'react';

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
 *
 * 并发保护（单飞）：setInterval 不保证上一轮已结束。弱网/云函数慢时，
 * 每拍都发新请求会越堆越多（还可能在响应乱序时用旧数据覆盖新数据）。
 * 这里加单飞锁：上一轮未落地就跳过本拍，等其他触发（含 onShow/refreshKey）
 * 在轮空后自然补上。
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

  /** 是否还挂着（卸载后不再发起新的一轮） */
  const aliveRef = useRef(true);
  /** 单飞锁：true 表示上一轮还在路上 */
  const inFlightRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const run = useCallback((silent: boolean) => {
    if (!aliveRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    Promise.resolve()
      .then(() => taskRef.current(silent))
      .catch((e) => {
        // task 自己可能已处理错误；这里兜住 Promise 拒绝，避免未捕获告警
        console.error('[usePolling] 轮询任务失败:', e);
      })
      .finally(() => { inFlightRef.current = false; });
  }, []);

  // 主循环只在 interval / enabled 变化时重建
  useEffect(() => {
    if (!enabled) return;

    run(false);

    if (interval <= 0) return;

    const timer = setInterval(() => {
      if (pausedRef.current) return; // 后台静默跳过（不积压不重复）
      run(true);
    }, interval);

    return () => clearInterval(timer);
  }, [interval, enabled, run]);

  // 前后台感知：hide 暂停 · show 补拉
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => { pausedRef.current = true; };
    const onShow = () => {
      if (!pausedRef.current) return; // 常规 tab 切换不触发 App 级 show
      pausedRef.current = false;
      run(true); // 静默补拉，避免 loading 闪烁
    };
    wx.onAppHide(onHide);
    wx.onAppShow(onShow);
    return () => {
      try { wx.offAppHide(onHide); } catch (e) { /* 老基础库无 off 版本时忽略 */ }
      try { wx.offAppShow(onShow); } catch (e) { /* 同上 */ }
    };
  }, [enabled, run]);

  // 外部要求刷新：只补拉一次（不重置计时器）
  const firstRefreshRef = useRef(true);
  useEffect(() => {
    if (firstRefreshRef.current) {
      firstRefreshRef.current = false;
      return; // 挂载时主循环已能拉动
    }
    if (!enabled) return;
    run(false);
  }, [refreshKey, enabled, run]);
}
