/**
 * H5 本地服务的安全策略（纯函数，可单独测试）。
 *
 * 集中处理 STRIDE 建模中确认的几类威胁：
 * - T-1 CSRF：跨站请求伪造关注操作
 * - D-1 请求体无上限：内存耗尽
 * - S-2 安全响应头缺失
 * - I-1 错误信息泄露绝对路径
 */

/** 请求体上限：关注接口只需要几十字节，64KB 已经非常宽松 */
const MAX_BODY_BYTES = 64 * 1024;

/** 允许的来源主机名（本机访问） */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 判断请求是否来自同源页面。
 *
 * 关键：CORS「简单请求」（Content-Type 为 text/plain / form-urlencoded）
 * 不会触发预检，浏览器会直接发出去。仅靠 CORS 头挡不住这类请求，
 * 必须服务端主动校验 Origin。
 *
 * 没有 Origin 头的情况（curl、Node 脚本、同源 GET）视为可信 ——
 * 浏览器发起的跨站 POST 一定会带 Origin。
 */
function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  // 同源请求可能是 "null"（file:// 或沙箱 iframe），一律拒绝
  if (origin === 'null') return false;

  try {
    const { hostname } = new URL(origin);
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

/**
 * 写接口必须声明 application/json。
 * 浏览器跨站要发 JSON 就必须触发预检，而预检过不了 —— 多一层保险。
 */
function hasJsonContentType(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.includes('application/json');
}

/** 写操作（POST/PUT/DELETE/PATCH）需要额外的来源与类型校验 */
function isWriteMethod(method) {
  return ['POST', 'PUT', 'DELETE', 'PATCH'].includes(String(method || '').toUpperCase());
}

/** 统一的响应头 */
function baseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // 只允许同源脚本；图片允许远端（抖音头像）
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'"
  };
}

/**
 * 把内部错误转成对外安全的消息。
 * 绝不把异常原文（含绝对路径、堆栈）返回给客户端。
 */
function toSafeError(e) {
  const raw = String((e && e.message) || '');
  // 文件损坏是用户可自行修复的问题，给出可操作但不含路径的提示
  if (raw.includes('损坏')) {
    return '关注列表文件已损坏，已中止操作以保护数据。请检查 scripts/follows.json 或从 .bak 恢复。';
  }
  if (raw.includes('过大')) return '请求体过大';
  if (raw.includes('权限') || raw.includes('EACCES')) return '没有文件读写权限';
  return '服务内部错误';
}

module.exports = {
  MAX_BODY_BYTES,
  LOCAL_HOSTNAMES,
  isTrustedOrigin,
  hasJsonContentType,
  isWriteMethod,
  baseHeaders,
  toSafeError
};
