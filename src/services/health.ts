import { callFunction } from './cloud';
import { RPC } from './rpc';

/** 云端体检分级：ok=全正常 / warn=有异常但巡检还在跑 / bad=巡检链路整体死亡 */
export type HealthLevel = 'ok' | 'warn' | 'bad';

export interface HealthSummary {
  level: HealthLevel;
  ok: boolean;
  reasons: string[];
  heartbeatAgeMin: number | null;
  guardianAgeMin: number | null;
  failStreak: number;
  incidentsOpen: number;
  lastHealOk: boolean | null;
}

/**
 * 读云端健康摘要（巡检心跳 / 守护者自检 / 连败轮数）。
 *
 * 为什么放在「我的」页：guardian 曾经掉了 18 天没人发现，因为告警只写进
 * 数据库。把状态摆到用户能看见的地方，是成本最低的「回路闭合」。
 *
 * 失败返回 null —— 「状态未知」本身就是有价值的信息，不要伪造 ok。
 */
export async function fetchHealth(): Promise<HealthSummary | null> {
  try {
    return await callFunction<HealthSummary>(RPC.metaReader, { mode: 'health' });
  } catch (e) {
    return null;
  }
}
