/**
 * 巡检节奏自适应（纯函数，无 SDK 依赖，可本地测试）。
 *
 * 背景：定时触发器固定每分钟唤起 watchLive，但云端免费环境有 QPS 与调用次数成本，
 * 且「主播长期离线」时段的分钟级查询纯属浪费。本模块根据上一轮结果决定
 * 「下一轮是全量巡检还是跳过冷却」：
 *
 * - 有主播在播（living）→ 分钟级，保住开播变化与新开场的及时性
 * - 全员离线          → 冷却 idleMinutes 分钟，开播提醒延迟上限 = idleMinutes
 * - 存在查询失败      → 按 failMinutes 退避，给抖音侧留恢复时间，也摊薄告警轮次
 *
 * 云函数 watchLive 经 sync-cloud-shared.js 拿到副本。
 */

/** 取配置值：只接受有限数字（非数字/非法回退默认），防御配置文件坏数据 */
function pickPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 30); // 单调冷却上限 30 分钟，防配置手误把巡检停掉
}

/**
 * 计算下一轮冷却分钟数。
 *
 * 失败自愈策略（连续失败指数退避）：
 *   第 1 轮失败 → failMinutes；第 2 轮 → ×2；第 3 轮 → ×4 … 上限 30 分钟。
 *   抖音接口抖动半分钟能自愈则只多等一分钟；持续大改版则自动减速，
 *   不白烧配额，也不需要任何人盯着。
 *
 * @param {object} ctx 上一轮巡检摘要
 * @param {boolean} ctx.anyLiving  是否有主播在播
 * @param {boolean} ctx.anyFailed  是否有查询失败的主播
 * @param {number}  [ctx.failStreak] 连续失败轮数（上一轮的值，写入方负责传递/清零）
 * @param {object} cfg 巡检配置（watch-config.json 的 pacing 段，可为空）
 * @param {number} [cfg.idleMinutes]  全员离线时的冷却分钟数（默认 2）
 * @param {number} [cfg.failMinutes]  出现查询失败时的冷却分钟数（默认 2）
 * @param {number} [cfg.activeMinutes] 有主播在播时的冷却分钟数（默认 1，等价不冷却）
 * @returns {number} 下一轮冷却分钟数（>=1）
 */
function decideCooldownMinutes(ctx, cfg) {
  const idle = pickPositiveInt(cfg && cfg.idleMinutes, 2);
  const fail = pickPositiveInt(cfg && cfg.failMinutes, 2);
  const active = pickPositiveInt(cfg && cfg.activeMinutes, 1);

  if (ctx && ctx.anyLiving) return active;
  if (ctx && ctx.anyFailed) {
    const streak = ctx && Number(ctx.failStreak) > 0 ? Math.floor(Number(ctx.failStreak)) : 0;
    const backoff = Math.min(streak, 4); // ×2^streak，封顶 ×8
    return Math.min(Math.max(idle, fail) * Math.pow(2, backoff), 30);
  }
  return idle;
}

module.exports = { decideCooldownMinutes };
