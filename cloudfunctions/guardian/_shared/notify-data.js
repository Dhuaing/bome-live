/**
 * 订阅消息 data 构造（纯函数，无 SDK 依赖，可本地测试）。
 *
 * 微信订阅消息要求 data 的键与模板里选的「字段」一一对配，
 * 而 watch-config.json 里存的是「业务字段 → 模板字段」的映射，
 * 本模块负责把它们组装成 openapi.subscribeMessage.send 需要的结构。
 *
 * 云函数 watchLive 经 sync-cloud-shared.js 拿到副本。
 */

/** 把时间戳格式化为 "YYYY-MM-DD HH:mm"，无效值返回空串 */
function formatTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  // 显式按东八区渲染：云函数容器是 UTC，若用本地时区方法会把开播时间掐快 8 小时
  // （踩过：订阅消息显示 06:59，实际北京时间 14:59）。
  const d = new Date(n + 8 * 60 * 60 * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/**
 * 开播通知的取值来源。
 * value 缺省时不进 data（模板字段必填会报错，可选字段留空最稳）。
 */
const NOTIFY_SUPPLY = {
  name: (info) => info.nickname || info.uniqueId || '',
  roomTitle: (info) => info.roomTitle || info.nickname || '',
  viewerCount: (info) => (info.viewerCount > 0 ? String(info.viewerCount) : ''),
  liveStartTime: (info) => formatTime(info.liveStartTime),
  /** 备注字段：模板若选了「备注」关键词则必填，给一句固定引导语 */
  note: () => '关注的主播开播啦，点进来看'
};

/** 故障告警的取值来源 */
const ALERT_SUPPLY = {
  detail: (ctx) => ctx && ctx.detail,
  failedAt: (ctx) => formatTime(ctx && ctx.failedAt)
};

/**
 * 按 keys 映射构造订阅消息 data。
 *
 * @param {object} info 云函数 getStreamerStatus 的返回 data
 * @param {Record<string,string>} keys watch-config.json 的 keys（业务字段 → 模板字段）
 * @returns {Record<string, { value: string }>}
 */
function buildSubsData(info, keys) {
  return buildData(NOTIFY_SUPPLY, info, keys);
}

/**
 * 构造故障告警的 data。
 * @param {{ detail: string, failedAt: number, failCount: number }} ctx
 */
function buildAlertData(ctx, keys) {
  return buildData(ALERT_SUPPLY, ctx, keys);
}

function buildData(supply, input, keys) {
  const data = {};
  for (const [field, key] of Object.entries(keys || {})) {
    const pick = supply[field];
    if (!pick || key === undefined || key === null || key === '') continue;
    const value = String(pick(input) == null ? '' : pick(input)).trim();
    if (!value) continue;
    // 订阅消息的单字段上限按关键词规则不同：thing 20 字以内（中英混排按字符计），
    // name 10 字，number/character_string 32 字符，time 无需处理。
    data[key] = { value: value.slice(0, valueLimit(key)) };
  }
  return data;
}

/** 按模板字段名前缀取单字段可下发字符数上限 */
function valueLimit(key) {
  const k = String(key);
  if (k.startsWith('thing')) return 20;
  if (k.startsWith('name')) return 10;
  return 32;
}

module.exports = { formatTime, buildSubsData, buildAlertData, NOTIFY_SUPPLY, ALERT_SUPPLY };
