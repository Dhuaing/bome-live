/**
 * STRIDE 安全回归探针：验证 P0/P1 修复是否生效。
 *
 * 只读 + 有限写入，跑完恢复 follows.json。
 * 用法：node scripts/security-probe.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.argv[2] || 3000);
const HOST = '127.0.0.1';
const FOLLOWS = path.join(import.meta.dirname, 'follows.json');

const results = [];

function req({ method = 'GET', path: p, headers = {}, body = null, host = HOST }) {
  return new Promise((resolve) => {
    const r = http.request({ host, port: PORT, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, body: '' }));
    r.setTimeout(8000, () => {
      r.destroy();
      resolve({ status: -1, error: 'timeout', body: '' });
    });
    if (body) r.write(body);
    r.end();
  });
}

function check(id, title, ok, detail) {
  results.push({ id, title, ok });
  console.log(`${ok ? '✅' : '❌'} [${id}] ${title}`);
  if (detail) console.log(`      ${detail}`);
}

function readFollows() {
  try {
    return JSON.parse(fs.readFileSync(FOLLOWS, 'utf8'));
  } catch {
    return [];
  }
}

async function main() {
  const original = fs.existsSync(FOLLOWS) ? fs.readFileSync(FOLLOWS, 'utf8') : '[]';

  // ── P0-1: 监听范围 ─────────────────────────────
  {
    const nets = os.networkInterfaces();
    const external = [];
    for (const addrs of Object.values(nets)) {
      for (const a of addrs || []) {
        if (!a.internal && a.family === 'IPv4') external.push(a.address);
      }
    }
    let lanReachable = false;
    if (external.length) {
      const code = await new Promise((resolve) => {
        const rq = http.request({ host: external[0], port: PORT, path: '/', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        rq.on('error', () => resolve(0));
        rq.setTimeout(3000, () => { rq.destroy(); resolve(-1); });
        rq.end();
      });
      lanReachable = code === 200;
    }
    check(
      'P0-1',
      '仅监听回环地址（局域网不可达）',
      !lanReachable,
      lanReachable ? `局域网 ${external[0]}:${PORT} 仍可访问` : `已阻断（网卡: ${external.join(', ') || '无'}）`
    );
  }

  // ── P0-2: CSRF（跨站 text/plain）────────────────
  {
    const body = JSON.stringify({ uniqueId: 'csrf_probe_999', action: 'follow', name: 'CSRF' });
    const r = await req({
      method: 'POST',
      path: '/api/toggleFollow',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example.com' },
      body
    });
    const added = readFollows().some((f) => f.uniqueId === 'csrf_probe_999');
    check(
      'P0-2a',
      'CSRF：跨站 text/plain 请求被拒绝',
      !added && r.status === 403,
      `HTTP ${r.status}，响应 ${r.body.slice(0, 70)}`
    );
  }

  // ── P0-2b: 跨站但用 application/json ────────────
  {
    const body = JSON.stringify({ uniqueId: 'csrf_probe_998', action: 'follow', name: 'CSRF2' });
    const r = await req({
      method: 'POST',
      path: '/api/toggleFollow',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body
    });
    const added = readFollows().some((f) => f.uniqueId === 'csrf_probe_998');
    check(
      'P0-2b',
      'CSRF：跨站 JSON 请求被 Origin 校验拒绝',
      !added && r.status === 403,
      `HTTP ${r.status}`
    );
  }

  // ── P0-2c: 本机 Origin 应当放行 ─────────────────
  {
    const body = JSON.stringify({ uniqueId: 'local_probe_1', action: 'follow', name: '本机' });
    const r = await req({
      method: 'POST',
      path: '/api/toggleFollow',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body
    });
    const added = readFollows().some((f) => f.uniqueId === 'local_probe_1');
    check('P0-2c', '同源请求正常放行（功能未被误伤）', added && r.status === 200, `HTTP ${r.status}`);
    if (added) {
      await req({
        method: 'POST',
        path: '/api/toggleFollow',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({ uniqueId: 'local_probe_1', action: 'unfollow' })
      });
    }
  }

  // ── P0-3: 请求体上限 ───────────────────────────
  {
    const big = 'x'.repeat(200 * 1024); // 200KB > 64KB
    const r = await req({
      method: 'POST',
      path: '/api/toggleFollow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uniqueId: 'a', action: 'follow', name: big })
    });
    check('P0-3', '超大请求体被拒绝', r.status === 413, `HTTP ${r.status}，响应 ${r.body.slice(0, 60)}`);
  }

  // ── P1-1: 安全响应头 ───────────────────────────
  {
    const r = await req({ path: '/' });
    const h = r.headers || {};
    const want = ['x-content-type-options', 'x-frame-options', 'referrer-policy'];
    const missing = want.filter((k) => !h[k]);
    if (process.env.PROBE_DEBUG) {
      console.log('      [debug] status=', r.status, 'headerKeys=', Object.keys(h).join(','));
    }
    const api = await req({
      method: 'POST',
      path: '/api/getUserFollows',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const apiHeaders = api.headers || {};
    const cspMissing = !apiHeaders['content-security-policy'];
    check(
      'P1-1',
      '安全响应头齐全（nosniff / frame / referrer / CSP）',
      missing.length === 0 && !cspMissing,
      missing.length ? `静态页缺少: ${missing.join(', ')}` : cspMissing ? 'API 缺少 CSP' : '全部存在'
    );
  }

  // ── P1-2: 错误信息脱敏 ─────────────────────────
  {
    fs.writeFileSync(FOLLOWS, '{ broken');
    const r = await req({
      method: 'POST',
      path: '/api/getUserFollows',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    fs.writeFileSync(FOLLOWS, original);
    const leaks = /[A-Za-z]:\\|\\scripts\\|\/scripts\//.test(r.body);
    check('P1-2', '错误信息不泄露绝对路径', !leaks, r.body.slice(0, 140));
  }

  // ── 回归：正常功能仍可用 ───────────────────────
  {
    const r = await req({
      method: 'POST',
      path: '/api/getUserFollows',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    let ok = false;
    try {
      ok = JSON.parse(r.body).code === 0;
    } catch {}
    check('REG-1', 'getUserFollows 正常工作', ok, `HTTP ${r.status}`);
  }

  {
    const r = await req({ path: '/' });
    check('REG-2', '静态首页正常返回', r.status === 200 && r.body.includes('<!doctype html'));
  }

  fs.writeFileSync(FOLLOWS, original);

  console.log('\n─────────────────────────────');
  const bad = results.filter((r) => !r.ok).length;
  console.log(`${results.length} 项检查，${results.length - bad} 通过，${bad} 失败`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
