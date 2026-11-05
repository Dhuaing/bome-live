/**
 * 自动生成，请勿手改。
 * 来源：shared/follow-rules.json
 * 重新生成：npm run gen:rules
 */


/** 抖音号允许的字符 */
export const VALID_UNIQUE_ID = /^[\w.-]+$/;

/** 直播间地址前缀 */
export const ROOM_URL_PREFIX = 'https://live.douyin.com/';

/** 昵称最大长度 */
export const MAX_NAME = 64;

/** URL 最大长度 */
export const MAX_URL = 512;

/** 只接受 http(s) */
const SAFE_URL = /^https?:\/\//i;

/** 从直播间地址中剥离前缀 */
const STRIP_ROOM_URL_PREFIX = /^https?:\/\/live\.douyin\.com\//i;

/** 剥离 query / hash */
const STRIP_QUERY_HASH = /[?#].*$/;

/** 关注 / 取关动作 */
export const ACTIONS = ["follow","unfollow"];

/** 关注记录的默认字段 */
const RECORD_DEFAULTS = {
  "platform": "douyin",
  "category": "",
  "description": "",
  "status": "offline"
};

/** 去掉控制字符并截断 */
function cleanText(value: unknown, maxLen: number): string {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex -- 本函数的职责就是清除控制字符
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

/** 只保留安全的 http(s) URL，否则返回空串 */
function cleanUrl(value: unknown, maxLen: number = MAX_URL): string {
  const text = cleanText(value, maxLen === undefined ? MAX_URL : maxLen);
  return SAFE_URL.test(text) ? text : '';
}

/**
 * 把用户输入规整成抖音号。
 * 支持直接填数字，也支持粘贴完整直播间地址（含 query / hash / 尾斜杠）。
 */
export function normalizeUniqueId(input?: string | null): string {
  return String(input == null ? '' : input)
    .trim()
    .replace(STRIP_ROOM_URL_PREFIX, '')
    .replace(STRIP_QUERY_HASH, '')
    .replace(/\/+$/, '')
    .trim();
}

/** 判断是否是合法的抖音号 */
export function isValidUniqueId(uniqueId?: string | null): boolean {
  const id = String(uniqueId == null ? '' : uniqueId).trim();
  return id.length > 0 && VALID_UNIQUE_ID.test(id);
}

/** 由抖音号拼出直播间地址 */
export function buildRoomUrl(uniqueId?: string | null): string {
  const id = String(uniqueId == null ? '' : uniqueId).trim();
  return id ? ROOM_URL_PREFIX + id : '';
}

/** 优先用给定的 roomUrl，没有则由抖音号拼 */
export function resolveRoomUrl(roomUrl?: string | null, uniqueId?: string | null): string {
  const given = String(roomUrl == null ? '' : roomUrl).trim();
  return given || buildRoomUrl(uniqueId);
}

/** 判断动作是否合法 */
export function isValidAction(action?: string | null): boolean {
  return ACTIONS.indexOf(String(action == null ? '' : action)) >= 0;
}

/**
 * 构造一条关注记录（新增或更新）。
 *
 * @param {{ uniqueId: string, name?: string, avatar?: string, roomUrl?: string }} input 用户提交
 * @param {object} [existing] 已存在的记录（更新时传入，用于保留旧值）
 * @param {number} [now] 时间戳，便于测试
 * @returns {object} 可直接写入存储的记录
 */
export function buildFollowRecord(
  input: { uniqueId?: string; name?: string; avatar?: string; roomUrl?: string },
  existing?: Record<string, any> | null,
  now?: number
): Record<string, any> {
  const params = input || {};
  const prev = existing || {};
  const ts = typeof now === 'number' ? now : Date.now();

  const uniqueId = String(params.uniqueId == null ? '' : params.uniqueId).trim();
  const name = cleanText(params.name, MAX_NAME) || cleanText(prev.name, MAX_NAME) || uniqueId;
  const avatar = cleanUrl(params.avatar) || cleanUrl(prev.avatar);
  const roomUrl =
    cleanUrl(params.roomUrl) || cleanUrl(prev.roomUrl) || buildRoomUrl(uniqueId);

  const record: Record<string, any> = {
    id: uniqueId,
    uniqueId: uniqueId,
    name: name,
    avatar: avatar,
    roomUrl: roomUrl,
    platform: prev.platform || RECORD_DEFAULTS.platform,
    category: prev.category || RECORD_DEFAULTS.category,
    description: prev.description || RECORD_DEFAULTS.description,
    status: prev.status || RECORD_DEFAULTS.status,
    // createdAt 只在首次创建时写入，更新时保留原值
    createdAt: prev.createdAt || ts,
    updatedAt: ts
  };

  return record;
}
