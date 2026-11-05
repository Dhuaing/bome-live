/**
 * H5 预览/生产同源服务器
 * - 静态托管 dist-h5 构建产物
 * - /api/getUserFollows、/api/toggleFollow 由本地实现（关注列表存 scripts/follows.json）
 * - 其余 /api/* 同源代理到 CloudBase 云函数 HTTP 网关（规避浏览器 CORS 与安全域名限制）
 *
 * 安全策略见 scripts/security.js：
 * - 默认只监听回环地址（不暴露给局域网）
 * - 写接口校验 Origin + Content-Type（防 CSRF）
 * - 请求体有大小上限
 * - 统一安全响应头，错误信息脱敏
 *
 * 用法：npm run serve:h5
 *      HOST=0.0.0.0 npm run serve:h5   # 需要手机同网调试时才显式放开
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { normalizeUniqueId, readFollows, writeFollows } = require('./follows-store');
const { buildFollowRecord, isValidAction } = require('./follow-record');
const { CLOUD_GATEWAY_HOST: GATEWAY_HOST } = require('./cloud-env');
const { readJsonBody, BodyTooLargeError } = require('./http-body');
const {
  isTrustedOrigin,
  hasJsonContentType,
  isWriteMethod,
  baseHeaders,
  toSafeError
} = require('./security');

const root = path.join(__dirname, '..', process.env.TARO_OUTPUT_DIR || 'dist-h5');
const port = process.env.PORT || 3000;
// 默认仅回环。局域网可达意味着同网段任何人都能读写关注列表。
const host = process.env.HOST || '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
};

/**
 * 本地实现的"云函数"，返回体与云函数保持同一套 { code, message, data } 契约，
 * 前端 services/cloud.ts 无需区分来源。
 */
const LOCAL_HANDLERS = {
  getUserFollows() {
    const list = readFollows();
    return {
      code: 0,
      message: 'success',
      data: { followedIds: list.map((f) => f.uniqueId), streamers: list }
    };
  },

  async toggleFollow(params) {
    const uniqueId = normalizeUniqueId(params.uniqueId);
    const action = params.action;
    if (!uniqueId || !isValidAction(action)) {
      return { code: -1, message: '参数不完整', data: null };
    }

    // readFollows 在文件损坏时会抛错（不再静默返回 []），
    // 这样绝不会把损坏当成"空列表"再回写覆盖掉真实数据。
    const list = readFollows();
    const next =
      action === 'follow'
        ? upsertFollow(list, uniqueId, params)
        : list.filter((f) => f.uniqueId !== uniqueId);

    await writeFollows(next);
    return {
      code: 0,
      message: action === 'follow' ? '关注成功' : '已取消关注',
      data: { followed: action === 'follow' }
    };
  }
};

/**
 * 新增或更新一条关注记录。
 * 记录构造委托给 follow-record（与云函数、前端共用同一套规则）。
 */
function upsertFollow(list, uniqueId, params) {
  const idx = list.findIndex((f) => f.uniqueId === uniqueId);
  const existing = idx >= 0 ? list[idx] : null;
  const record = buildFollowRecord({ ...params, uniqueId }, existing);

  if (idx < 0) return [...list, record];

  const next = [...list];
  next[idx] = record;
  return next;
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, baseHeaders());
  res.end(JSON.stringify(payload));
}

/** 处理本地实现的接口 */
async function handleLocalApi(req, res, name) {
  try {
    const params = await readJsonBody(req);
    sendJson(res, await LOCAL_HANDLERS[name](params));
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return sendJson(res, { code: -1, message: toSafeError(e), data: null }, 413);
    }
    // 细节只进日志，不回给客户端（避免泄露绝对路径）
    console.error(`[serve-h5] ${name} 失败:`, e);
    sendJson(res, { code: -1, message: toSafeError(e), data: null }, 500);
  }
}

/** 转发到云函数网关 */
function proxy(req, res) {
  const gatewayPath = req.url.replace(/^\/api/, '') || '/';
  const chunks = [];
  let size = 0;

  req.on('data', (c) => {
    size += c.length;
    if (size > 64 * 1024) {
      req.destroy();
      return sendJson(res, { code: -1, message: '请求体过大', data: null }, 413);
    }
    chunks.push(c);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upstream = https.request(
      {
        host: GATEWAY_HOST,
        path: gatewayPath,
        method: req.method,
        headers: { 'Content-Type': 'application/json', host: GATEWAY_HOST }
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', (e) => {
      console.error('[serve-h5] 代理失败:', e.message);
      sendJson(res, { code: -1, message: '上游服务不可用', data: null }, 502);
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/** 静态文件（含路径穿越防护） */
function serveStatic(req, res, pathname) {
  const p = pathname === '/' ? '/index.html' : pathname;
  const rootAbs = path.resolve(root);
  const fp = path.resolve(rootAbs, '.' + p);

  if (fp !== rootAbs && !fp.startsWith(rootAbs + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.readFile(fp, (e, d) => {
    if (!e) return sendFile(res, fp, d);
    // SPA 回退
    fs.readFile(path.join(rootAbs, 'index.html'), (e2, d2) => {
      if (e2) {
        res.writeHead(404);
        return res.end('404');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(d2);
    });
  });
}

function sendFile(res, fp, data) {
  res.writeHead(200, {
    'Content-Type': types[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': fp.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(data);
}

/** 解析并校验 URL，畸形编码返回 null */
function parsePathname(req) {
  try {
    return decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return null;
  }
}

/** 写接口的额外校验：来源 + 内容类型 */
function rejectUnsafeWrite(req, res) {
  if (!isWriteMethod(req.method)) return false;
  if (!isTrustedOrigin(req)) {
    sendJson(res, { code: -1, message: '非法的请求来源', data: null }, 403);
    return true;
  }
  if (!hasJsonContentType(req)) {
    sendJson(res, { code: -1, message: '请求必须为 application/json', data: null }, 415);
    return true;
  }
  return false;
}

http
  .createServer((req, res) => {
    const pathname = parsePathname(req);
    if (pathname === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 Bad Request: 非法的 URL 编码');
    }

    if (rejectUnsafeWrite(req, res)) return;

    if (pathname.startsWith('/api/')) {
      const name = pathname.slice('/api/'.length);
      if (Object.prototype.hasOwnProperty.call(LOCAL_HANDLERS, name)) {
        return handleLocalApi(req, res, name);
      }
      return proxy(req, res);
    }

    serveStatic(req, res, pathname);
  })
  .listen(port, host, () => {
    console.log(`H5 server running at http://${host}:${port} (root: ${root})`);
    console.log(`API proxy: /api/* -> https://${GATEWAY_HOST}/*  (getUserFollows/toggleFollow 由本地处理)`);
    if (host === '0.0.0.0') {
      console.warn('[warn] 已监听所有网卡，局域网内其他设备可访问本服务');
    }
  });
