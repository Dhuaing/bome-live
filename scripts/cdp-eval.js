#!/usr/bin/env node
/**
 * CDP 求值助手（收进仓库——旧版放 %TEMP% 会被系统周期清理，
 * 导致 duty 云端读数静默降级，坑位 #13）。
 *
 * 用法：node scripts/cdp-eval.js <URL子串> <base64(JS 表达式)>
 * 行为：连 127.0.0.1:9223 的 CDP，找 URL 含 <URL子串> 的 target，
 *       Runtime.evaluate（awaitPromise + returnByValue）后输出一行
 *       JSON.stringify({ type, value })；求值抛错时打印 EXCEPTION 并照常
 *       输出（value 通常为 null），找不到 target 时打印 TARGET-NOT-FOUND 退 2。
 */
const [, , urlPart = '', exprB64 = ''] = process.argv;

async function main() {
  if (!urlPart || !exprB64) {
    console.error('usage: node scripts/cdp-eval.js <URL子串> <base64表达式>');
    process.exit(2);
  }
  const res = await fetch('http://127.0.0.1:9223/json');
  const targets = await res.json();
  const t = targets.find((x) => (x.url || '').includes(urlPart));
  if (!t || !t.webSocketDebuggerUrl) {
    console.error('TARGET-NOT-FOUND');
    process.exit(2);
  }

  const expr = Buffer.from(exprB64, 'base64').toString('utf8');
  const ws = new WebSocket(t.webSocketDebuggerUrl);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 求值超时(30s)')), 30000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) return reject(new Error(`CDP 错误：${msg.error.message}`));
      if (msg.result && msg.result.exceptionDetails) {
        console.error('EXCEPTION: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 400));
      }
      resolve((msg.result && msg.result.result) || null);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); });
  });

  console.log(JSON.stringify({
    type: result ? result.type : 'undefined',
    value: result ? result.value : undefined,
  }));
  try { ws.close(); } catch (e) { /* 忽略 */ }
  process.exit(0);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
