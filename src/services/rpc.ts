/**
 * 后端接口名（RPC 方法名）。
 *
 * 收在这里的原因：
 * - 函数名原本散落在 service / 本地 handler / 云函数 / 巡检脚本里，
 *   改名要同时改多处，容易漏
 * - 未来若换成 REST 后端，只需在这里做一次「方法名 → 路径」的映射
 *
 * 注意：这里只是「名字」，不含任何实现或传输方式。
 */
export const RPC = {
  getUserFollows: 'getUserFollows',
  toggleFollow: 'toggleFollow',
  getStreamerStatus: 'getStreamerStatus',
  notifyQuota: 'notifyQuota'
} as const;

export type RpcName = (typeof RPC)[keyof typeof RPC];
