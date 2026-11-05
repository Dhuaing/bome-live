/**
 * 开播巡检的判定逻辑（纯函数，无副作用）。
 *
 * 共享源维护在本文件（cloudfunctions/_shared/watch-rules.js）：
 * - 云函数 watchLive 经 sync-cloud-shared.js 同步副本
 * - 本机脚本 scripts/watch-live.js 跨目录 require
 * 单一来源，不允许出现第二份手写副本。
 *
 * 从 watch-live.js 的 runRound 里抽出，使「该不该推送」这件事
 * 可以独立推理和测试，不与网络请求、文件读写混在一起。
 *
 * 同场合并（防重复推送）：
 * 一次性订阅额度是用户资产，同一场直播推两遍 = 多烧额度 + 骚扰。
 * 实际事故：抖音推流重连会让 create_time 漂移（同场 +43min、标题不变），
 * 旧规则「living→living 跳变>5min 即新开场」误判再推。两个成因都堵：
 * ① 直播中 create_time 漂移 → 噪声窗 + 合并窗 + 标题比对；
 * ② 撤流 <1min 又重开（离线轮可能根本没被观察到）→ offline→living
 *    时用 lastPushAt 回看合并窗。代价：90min 内同标题真重开不推（可接受）。
 */

/** create_time 噪声窗：持续直播中开播时间漂移 ≤ 此值一律视为抖动 */
const SESSION_CHANGE_MIN_MS = 5 * 60 * 1000;

/** 同场合并窗：距上次推送 ≤ 此值且直播间标题未变 → 视为同场，不重复推送 */
const SESSION_MERGE_MS = 90 * 60 * 1000;

/** 把云端返回的 status 归一到 living / offline */
function normalizeStatus(info) {
  return info && info.status === 'living' ? 'living' : 'offline';
}

/** 取有效的开播时间戳（无效一律归 0） */
function normalizeStartTime(info) {
  const t = info && info.liveStartTime;
  return t > 0 ? t : 0;
}

/** 取直播间标题（缺省归空串，trim 掉首尾空白防假性不一致） */
function normalizeRoomTitle(info) {
  const t = info && info.roomTitle;
  return typeof t === 'string' ? t.trim() : '';
}

/** 标题没变（两边标题都在且相等才会 true——信息缺失时不认定同场，宁可误报不漏报） */
function sameRoomTitle(prevTitle, title) {
  return !!prevTitle && !!title && prevTitle === title;
}

/**
 * 判断本轮是否需要推送。
 *
 * 规则（按判定顺序）：
 * 1. 首次见到该主播 → 不推（静默记录，避免补推历史开播）
 * 2. living→offline / offline→offline → 不推
 * 3. offline→living → 推；
 *    例外：lastPushAt 在合并窗内且标题没换 → 视为掉线秒重开（同场延续），不推
 * 4. living→living（开播时间跳变 Δ）：
 *    - Δ ≤ 噪声窗 → create_time 抖动，不推
 *    - Δ ≤ 合并窗且标题不变 → 推流重连导致的时间漂移，同场，不推
 *    - 其余 → 中间真的新开了一场 → 推
 */
function shouldNotify(prev, current, startTime, roomTitle, now) {
  if (!prev) return false;

  if (prev.status !== 'living' && current === 'living') {
    const recentlyPushed =
      prev.lastPushAt > 0 && now - prev.lastPushAt <= SESSION_MERGE_MS;
    if (recentlyPushed && sameRoomTitle(prev.roomTitle, roomTitle)) return false;
    return true;
  }

  if (prev.status !== 'living' || current !== 'living') return false;
  if (!prev.sessionKey || !startTime) return false;
  const drift = Math.abs(startTime - prev.sessionKey);
  if (drift <= SESSION_CHANGE_MIN_MS) return false;
  if (drift <= SESSION_MERGE_MS && sameRoomTitle(prev.roomTitle, roomTitle)) {
    return false;
  }
  return true;
}

/**
 * 由「上次状态 + 本次查询结果」算出新的状态条目与是否推送。
 *
 * @param {object|undefined} prev 上次状态（无则视为首次）
 * @param {object} info 本次查询结果
 * @param {number} [now] 当前时间戳（默认 Date.now()，测试可注入）
 * @returns {{ next: object, notify: boolean, current: string }}
 */
function evaluate(prev, info, now = Date.now()) {
  const current = normalizeStatus(info);
  const startTime = normalizeStartTime(info);
  const roomTitle = normalizeRoomTitle(info);
  const notify = shouldNotify(prev, current, startTime, roomTitle, now);

  const living = current === 'living';
  const next = {
    status: current,
    // 离线轮沿用上一场标题：合并窗证据不能丢。
    // note：云端 putStateDoc 是 patch 合并、本机脚本是整体覆盖，
    // next 显式带旧值才能让两种存储方式都保留这些字段。
    roomTitle: living ? roomTitle || (prev && prev.roomTitle) || '' : (prev && prev.roomTitle) || '',
    sessionKey: living ? startTime || (prev && prev.sessionKey) || 0 : 0,
    // 推送轮记下推送时刻（合并窗锚点）；未推送轮保留旧值
    lastPushAt: notify ? now : (prev && prev.lastPushAt) || 0,
    lastCheckedAt: now
  };

  return { next, notify, current };
}

/** 组装推送文案（本机 nanobot 备用链路用的文本格式） */
function formatMessage(follow, info, fallbackRoomUrl) {
  const name = info.nickname || follow.name || follow.uniqueId;
  const lines = [`🔴 ${name} 开播了`];
  if (info.roomTitle) lines.push(`直播间：${info.roomTitle}`);
  if (info.viewerCount) lines.push(`在线人数：${info.viewerCount}`);
  lines.push(info.roomUrl || follow.roomUrl || fallbackRoomUrl);
  return lines.join('\n');
}

module.exports = { SESSION_CHANGE_MIN_MS, SESSION_MERGE_MS, evaluate, formatMessage, shouldNotify };
