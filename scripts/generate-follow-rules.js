/**
 * 从 shared/follow-rules.json 生成三份等价的实现。
 *
 * 背景：项目的三个运行环境无法共享代码
 * - src/            前端 TS，Taro/webpack 打包，只认 src/ 内的相对路径与 @/ 别名
 * - scripts/        Node CJS，直接 require
 * - cloudfunctions/ 微信独立部署，只能 require 自己目录内的文件
 *
 * 因此采用「规则单一真相 + 构建时生成」：
 *   shared/follow-rules.json  → 三份目标代码
 *
 * 生成物带 "自动生成" 头，不要手改；改规则请改 JSON 后重跑本脚本。
 *
 * 用法：node scripts/generate-follow-rules.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RULES_PATH = path.join(ROOT, 'shared', 'follow-rules.json');

const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

const HEADER = `/**
 * 自动生成，请勿手改。
 * 来源：shared/follow-rules.json
 * 重新生成：npm run gen:rules
 */
`;

/** 生成核心逻辑体（TS 与 CJS 只在导出语法上不同） */
function buildBody() {
  const { uniqueId, limits, url, record, actions } = rules;

  return {
    uniqueIdPattern: uniqueId.pattern,
    roomUrlPrefix: uniqueId.roomUrlPrefix,
    maxName: limits.name,
    maxUrl: limits.url,
    urlPattern: url.pattern,
    defaults: record.defaults,
    actions,
    stripRoomUrlPrefix: uniqueId.stripRoomUrlPrefix,
    stripQueryHash: uniqueId.stripQueryHash
  };
}

const consts = buildBody();

/** 公共的函数实现（纯 JS，两种模块风格都适用） */
function buildFunctions() {
  return `
/** 抖音号允许的字符 */
const VALID_UNIQUE_ID = /${consts.uniqueIdPattern}/;

/** 直播间地址前缀 */
const ROOM_URL_PREFIX = '${consts.roomUrlPrefix}';

/** 昵称最大长度 */
const MAX_NAME = ${consts.maxName};

/** URL 最大长度 */
const MAX_URL = ${consts.maxUrl};

/** 只接受 http(s) */
const SAFE_URL = /${consts.urlPattern}/i;

/** 从直播间地址中剥离前缀 */
const STRIP_ROOM_URL_PREFIX = /${consts.stripRoomUrlPrefix}/i;

/** 剥离 query / hash */
const STRIP_QUERY_HASH = /${consts.stripQueryHash}/;

/** 关注 / 取关动作 */
const ACTIONS = ${JSON.stringify(consts.actions)};

/** 关注记录的默认字段 */
const RECORD_DEFAULTS = ${JSON.stringify(consts.defaults, null, 2).replace(/\n/g, '\n')};

/** 去掉控制字符并截断 */
function cleanText(value, maxLen) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex -- 本函数的职责就是清除控制字符
    .replace(/[\\u0000-\\u001F\\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

/** 只保留安全的 http(s) URL，否则返回空串 */
function cleanUrl(value, maxLen) {
  const text = cleanText(value, maxLen === undefined ? MAX_URL : maxLen);
  return SAFE_URL.test(text) ? text : '';
}

/**
 * 把用户输入规整成抖音号。
 * 支持直接填数字，也支持粘贴完整直播间地址（含 query / hash / 尾斜杠）。
 */
function normalizeUniqueId(input) {
  return String(input == null ? '' : input)
    .trim()
    .replace(STRIP_ROOM_URL_PREFIX, '')
    .replace(STRIP_QUERY_HASH, '')
    .replace(/\\/+$/, '')
    .trim();
}

/** 判断是否是合法的抖音号 */
function isValidUniqueId(uniqueId) {
  const id = String(uniqueId == null ? '' : uniqueId).trim();
  return id.length > 0 && VALID_UNIQUE_ID.test(id);
}

/** 由抖音号拼出直播间地址 */
function buildRoomUrl(uniqueId) {
  const id = String(uniqueId == null ? '' : uniqueId).trim();
  return id ? ROOM_URL_PREFIX + id : '';
}

/** 优先用给定的 roomUrl，没有则由抖音号拼 */
function resolveRoomUrl(roomUrl, uniqueId) {
  const given = String(roomUrl == null ? '' : roomUrl).trim();
  return given || buildRoomUrl(uniqueId);
}

/** 判断动作是否合法 */
function isValidAction(action) {
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
function buildFollowRecord(input, existing, now) {
  const params = input || {};
  const prev = existing || {};
  const ts = typeof now === 'number' ? now : Date.now();

  const uniqueId = String(params.uniqueId == null ? '' : params.uniqueId).trim();
  const name = cleanText(params.name, MAX_NAME) || cleanText(prev.name, MAX_NAME) || uniqueId;
  const avatar = cleanUrl(params.avatar) || cleanUrl(prev.avatar);
  const roomUrl =
    cleanUrl(params.roomUrl) || cleanUrl(prev.roomUrl) || buildRoomUrl(uniqueId);

  const record = {
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
`;
}

const fns = buildFunctions();

// ── 1. TypeScript 版（前端）─────────────────────────
function genTs() {
  const withTypes = fns
    .replace(
      'function cleanText(value, maxLen) {',
      'function cleanText(value: unknown, maxLen: number): string {'
    )
    .replace(
      'function cleanUrl(value, maxLen) {',
      'function cleanUrl(value: unknown, maxLen: number = MAX_URL): string {'
    )
    .replace(
      'function isValidUniqueId(uniqueId) {',
      'export function isValidUniqueId(uniqueId?: string | null): boolean {'
    )
    .replace(
      'function normalizeUniqueId(input) {',
      'export function normalizeUniqueId(input?: string | null): string {'
    )
    .replace(
      'function buildRoomUrl(uniqueId) {',
      'export function buildRoomUrl(uniqueId?: string | null): string {'
    )
    .replace(
      'function resolveRoomUrl(roomUrl, uniqueId) {',
      'export function resolveRoomUrl(roomUrl?: string | null, uniqueId?: string | null): string {'
    )
    .replace(
      'function isValidAction(action) {',
      'export function isValidAction(action?: string | null): boolean {'
    )
    .replace(
      'function buildFollowRecord(input, existing, now) {',
      'export function buildFollowRecord(\n  input: { uniqueId?: string; name?: string; avatar?: string; roomUrl?: string },\n  existing?: Record<string, any> | null,\n  now?: number\n): Record<string, any> {'
    )
    .replace(
      'const record = {',
      'const record: Record<string, any> = {'
    )
    // 常量也导出，便于调用方复用
    .replace(/^const VALID_UNIQUE_ID/m, 'export const VALID_UNIQUE_ID')
    .replace(/^const MAX_NAME/m, 'export const MAX_NAME')
    .replace(/^const MAX_URL/m, 'export const MAX_URL')
    .replace(/^const ROOM_URL_PREFIX/m, 'export const ROOM_URL_PREFIX')
    .replace(/^const ACTIONS/m, 'export const ACTIONS');

  return HEADER + '\n' + withTypes;
}

// ── 2. CommonJS 版（scripts/）───────────────────────
function genCjs() {
  const exports = [
    'VALID_UNIQUE_ID',
    'ROOM_URL_PREFIX',
    'MAX_NAME',
    'MAX_URL',
    'ACTIONS',
    'RECORD_DEFAULTS',
    'cleanText',
    'cleanUrl',
    'normalizeUniqueId',
    'isValidUniqueId',
    'buildRoomUrl',
    'resolveRoomUrl',
    'isValidAction',
    'buildFollowRecord'
  ];
  return (
    HEADER +
    '\n' +
    fns +
    '\nmodule.exports = {\n' +
    exports.map((e) => `  ${e}: ${e}`).join(',\n') +
    '\n};\n'
  );
}

// ── 3. 云函数版（与 CJS 相同内容，落到 _shared）──────
function genCloud() {
  return genCjs();
}

const targets = [
  { file: 'src/utils/followRecord.ts', content: genTs() },
  { file: 'scripts/follow-record.js', content: genCjs() },
  { file: 'cloudfunctions/_shared/follow-record.js', content: genCloud() }
];

let changed = 0;
for (const t of targets) {
  const full = path.join(ROOT, t.file);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const prev = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  if (prev === t.content) {
    console.log(`[gen:rules] 无变化 ${t.file}`);
    continue;
  }
  fs.writeFileSync(full, t.content, 'utf8');
  console.log(`[gen:rules] 已更新 ${t.file}`);
  changed += 1;
}

console.log(`[gen:rules] 完成，${changed} 个文件有变化`);
