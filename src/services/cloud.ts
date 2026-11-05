import Taro from '@tarojs/taro'
import { CLOUD_ENV_ID } from '@/constants/cloud'

const isWeapp = process.env.TARO_ENV === 'weapp'

// 云开发就绪标记：首次调用前保证 init 已执行。
// 背景坑：React 里子组件 effect 先于父组件执行，若 init 写在 App 的 useEffect，
// StreamerStore 的首拉会先于 init 跑并报「Cloud API isn't enabled, please call wx.cloud.init first」，
// 报错又被 store 吞掉 → 关注列表永远空白。这里按调用兜底，谁先需要谁触发。
let cloudInitialized = false
function ensureCloudInit() {
  if (!isWeapp || cloudInitialized) return
  try {
    // wx.cloud.init 是同步的，重复调用幂等；这里只为显式保证时机
    Taro.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
  } catch (e) {
    console.error('[Cloud] init failed:', e)
  }
  cloudInitialized = true
}

// H5 走同源 /api 网关（本地由静态服务器代理到云函数 HTTP 网关；
// 生产环境在静态托管同域配置 /api 路由），微信小程序走 Taro.cloud
const GATEWAY_BASE = '/api'

/**
 * 幂等读端点白名单：网络抖动时最多自动重试一次。
 * 只放纯读（不产生副作用）的 RPC——写类（toggleFollow/notifyQuota earn）
 * 有自己的业务语义（记账/乐观更新），重试会造成双记账，绝不进名单。
 */
const RETRYABLE_RPC = new Set(['getStreamerStatus', 'getUserFollows']);

/** 网络层瞬断重试：仅对白名单端点，最多一次短退避 */
async function withTransportRetry<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!RETRYABLE_RPC.has(name)) throw e;
    await new Promise((r) => setTimeout(r, 700));
    return fn();
  }
}

/**
 * 调用云函数。
 * 失败一律抛错，不再回退本地假数据——宁可让调用方显示错误，
 * 也不能把伪造的状态/成功当真实结果展示给用户。
 * 业务错误（code!=0）永不重试；仅读端点的传输层瞬断自动重试一次。
 */
export async function callFunction<T = any>(name: string, data?: Record<string, any>): Promise<T> {
  // 微信小程序走 Taro.cloud
  if (isWeapp) {
    ensureCloudInit()
    return withTransportRetry(name, async () => {
      const res = await Taro.cloud.callFunction({ name, data })
      const result = res.result as { code: number; message: string; data: T }
      if (result.code !== 0) {
        console.error(`[Cloud] ${name} failed:`, result.message)
        throw new Error(result.message || '请求失败')
      }
      return result.data
    })
  }

  // H5 走 HTTP 网关
  return withTransportRetry(name, async () => {
    const resp = await fetch(`${GATEWAY_BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    })
    const result = (await resp.json()) as { code: number; message: string; data: T }
    if (result.code !== 0) {
      throw new Error(result.message || '请求失败')
    }
    return result.data
  })
}

export function getDatabase() {
  if (!isWeapp) {
    return null
  }
  ensureCloudInit()
  return Taro.cloud.database()
}