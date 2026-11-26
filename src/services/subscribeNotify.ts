import Taro from '@tarojs/taro';
import { SUBS_TEMPLATE_ID } from '@/constants/notify';
import { earnQuota } from './notifyQuota';

export type NotifyPermissionResult = 'accepted' | 'rejected' | 'unavailable';

// Taro 4.1.9 的类型定义错并了签名（要求 entityIds），微信真实 API 只有 tmplIds。
// 见 https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscription-message/wx.requestSubscribeMessage.html
type SubscribeOptions = { tmplIds: string[] };
type SubscribeResult = Record<string, string | undefined> & { errMsg?: string };
const requestSubscribeMessage = Taro.requestSubscribeMessage as unknown as (
  options: SubscribeOptions
) => Promise<SubscribeResult>;

/**
 * 开播提醒的订阅入口（一次性订阅消息）。
 *
 * 额度模型：用户每点一次「允许」给该模板攒一条推送额度，
 * 云函数 watchLive 在主播开播时消费一条发通知。
 * 所以这次调用只是「攒额度」，批量推送靠云端触发器逐分钟巡检。
 *
 * silent 模式用于「打开页面自动补攒」：
 * - 勾过「总是允许」的用户零打扰，静默攒一条额度
 * - 未勾选的用户，微信会忽略无手势调用（不会弹窗骚扰），静默失败
 * - 所以 silent 模式全程不出 toast，结果只用于埋点/调试
 *
 * 三种结果都给用户明确反馈，不假装成功：
 * - accepted：用户同意（额度记账失败时提示「已授权，额度同步暂未完成」）
 * - rejected：用户拒绝总开关或该次弹窗（可再次点击开启）
 * - unavailable：模板 ID 未配置，链路本身不可用
 */
export async function requestLiveNotifyPermission(
  opts: { silent?: boolean } = {}
): Promise<NotifyPermissionResult> {
  const show = opts.silent
    ? () => {}
    : (title: string, icon: 'none' | 'success' = 'none') =>
        Taro.showToast({ title, icon });
  // 模板还没配置（touristappid 阶段走不到这一步，这里兜底防止误报错）
  if (!SUBS_TEMPLATE_ID) {
    show('提醒模板尚未配置，暂不可开启');
    return 'unavailable';
  }

  try {
    // 幂等键：本次弹窗调用生成一个，只有真正 accept 才随 earn 上送——
    // 云端按它去重，同一「允许」的重试/双击不会双记账
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const res = await requestSubscribeMessage({ tmplIds: [SUBS_TEMPLATE_ID] });
    const accepted =
      res[SUBS_TEMPLATE_ID] === 'accept' && (res.errMsg || 'ok').includes('ok');
    if (accepted) {
      // 平台侧额度 +1 已发生，把它记进自建账本（显示层宁虚低不虚高）。
      // earnQuota 失败返回 null（不抛错）：微信没有余额查询 API，无法补偿，
      // 只能如实告诉用户「授权成功但账本没跟上」，不能谎称额度已到账。
      const quota = await earnQuota(requestId);
      if (quota) {
        show('已开启开播提醒', 'success');
      } else {
        show('已开启提醒，额度同步暂未完成');
      }
      return 'accepted';
    }
    show('未开启，可再次点击');
    return 'rejected';
  } catch (e: any) {
    // 静默补攒被微信忽略（未勾「总是允许」+ 无手势触发）是常态，降级为 info，
    // 不在控制台制造每次打开页面一条Error 的噪音
    if (opts.silent) {
      console.info('[subscribeNotify] silent auto-subscribe skipped:', e?.errMsg || e);
    } else {
      console.error('[subscribeNotify] requestSubscribeMessage failed:', e);
    }
    show(e?.errMsg || '订阅失败，请重试');
    return 'rejected';
  }
}
