/**
 * watch-rules 判定规则单测：重点钉死「同场重复推送」bug（坑 #8）。
 *
 * 事故背景：用户收到同标题两条推送（开播时间 15:00 与 15:43，同为
 * 「龙王殿集合！！！」）。成因两条，测试各钉一条：
 * A. 直播中 create_time 推流重连漂移（living→living 一路在播）
 * B. 撤流 <1min 又重开（离线轮根本没被每分钟巡检观察到，直接 offline→living）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  SESSION_CHANGE_MIN_MS,
  SESSION_MERGE_MS,
  evaluate
} = require('../cloudfunctions/_shared/watch-rules');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const TITLE = '龙王殿集合！！！';

// ── A 成因：直播中 create_time 漂移 ──

test('living→living：43min 漂移 + 标题不变 → 同场不推（事故 A 的实锤复现）', () => {
  const prev = {
    status: 'living',
    sessionKey: NOW - 43 * MIN,
    roomTitle: TITLE,
    lastPushAt: NOW - 43 * MIN
  };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, false);
  // 静默更新：时间锚点前移到漂移后的值，标题保留
  assert.strictEqual(r.next.sessionKey, NOW);
  assert.strictEqual(r.next.roomTitle, TITLE);
  // 未推送轮 lastPushAt 保留旧值（合并窗不重置，防连环跳变绕过窗口）
  assert.strictEqual(r.next.lastPushAt, prev.lastPushAt);
});

test('living→living：连续两次漂移叠加仍不推（lastPushAt 不被静默轮重置）', () => {
  const prev = { status: 'living', sessionKey: NOW - 86 * MIN, roomTitle: TITLE, lastPushAt: NOW - 86 * MIN };
  const r1 = evaluate(prev, { status: 'living', liveStartTime: NOW - 43 * MIN, roomTitle: TITLE }, NOW);
  assert.strictEqual(r1.notify, false);
  const r2 = evaluate(r1.next, { status: 'living', liveStartTime: NOW - 20 * MIN, roomTitle: TITLE }, NOW + 2 * MIN);
  assert.strictEqual(r2.notify, false);
});

test('living→living：漂移超过合并窗（>90min）→ 判新开场，推送', () => {
  const prev = { status: 'living', sessionKey: NOW - 95 * MIN, roomTitle: TITLE, lastPushAt: NOW - 95 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, true);
  assert.strictEqual(r.next.lastPushAt, NOW);
});

test('living→living：窗内漂移但标题换了 → 判新开场，推送', () => {
  const prev = { status: 'living', sessionKey: NOW - 30 * MIN, roomTitle: TITLE, lastPushAt: NOW - 30 * MIN };
  const r = evaluate(
    prev,
    { status: 'living', liveStartTime: NOW, roomTitle: '换了场，换个标题' },
    NOW
  );
  assert.strictEqual(r.notify, true);
  assert.strictEqual(r.next.roomTitle, '换了场，换个标题');
});

test('living→living：漂移 6min 但两边都没拿到标题 → 信息缺失，宁可误报不漏报（推送）', () => {
  const prev = { status: 'living', sessionKey: NOW - 6 * MIN, lastPushAt: NOW - 6 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW }, NOW);
  assert.strictEqual(r.notify, true);
});

test('living→living：≤5min 的小抖动仍属噪声窗，不推', () => {
  const prev = { status: 'living', sessionKey: NOW - 4 * MIN, roomTitle: TITLE, lastPushAt: NOW - 4 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW - 2 * MIN, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, false);
});

// ── B 成因：掉线秒重开（离线轮未被观察到）──

test('offline→living：40min 前刚推过 + 标题不变 → 同场重开不推（事故 B 的实锤复现）', () => {
  const prev = { status: 'offline', sessionKey: 0, roomTitle: TITLE, lastPushAt: NOW - 40 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, false);
  // 状态条目正常刷新到在播，锚点更新
  assert.strictEqual(r.next.status, 'living');
  assert.strictEqual(r.next.sessionKey, NOW);
  assert.strictEqual(r.next.roomTitle, TITLE);
});

test('offline→living：窗内重开但标题换了 → 推送', () => {
  const prev = { status: 'offline', sessionKey: 0, roomTitle: TITLE, lastPushAt: NOW - 40 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: '新节目' }, NOW);
  assert.strictEqual(r.notify, true);
  assert.strictEqual(r.next.roomTitle, '新节目');
});

test('offline→living：上次推送超过合并窗 → 正常推送', () => {
  const prev = { status: 'offline', sessionKey: 0, roomTitle: TITLE, lastPushAt: NOW - 3 * 60 * MIN };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, true);
});

test('offline→living：从未推过（lastPushAt=0）→ 正常推送', () => {
  const prev = { status: 'offline', sessionKey: 0, roomTitle: TITLE, lastPushAt: 0 };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, true);
});

// ── 字段保鲜：离线轮不丢合并窗证据 ──

test('living→offline：next 保留 roomTitle 与 lastPushAt（patch/整体覆盖两种存储都安全）', () => {
  const prev = { status: 'living', sessionKey: NOW - 10 * MIN, roomTitle: TITLE, lastPushAt: NOW - 10 * MIN };
  const r = evaluate(prev, { status: 'offline' }, NOW);
  assert.strictEqual(r.notify, false);
  assert.strictEqual(r.next.sessionKey, 0);
  assert.strictEqual(r.next.roomTitle, TITLE);
  assert.strictEqual(r.next.lastPushAt, prev.lastPushAt);
});

// ── 首推与既有语义不回归 ──

test('evaluate：首次见到不推送', () => {
  const r = evaluate(undefined, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, false);
});

test('evaluate：living → offline 不推送', () => {
  const r = evaluate({ status: 'living', sessionKey: NOW, roomTitle: TITLE, lastPushAt: NOW }, { status: 'offline' }, NOW);
  assert.strictEqual(r.notify, false);
});

test('evaluate：now 默认取 Date.now()，第三参可注入（离线轮推送不适用合并窗）', () => {
  const prev = { status: 'offline', sessionKey: 0, roomTitle: TITLE, lastPushAt: SESSION_MERGE_MS + 1 };
  const r = evaluate(prev, { status: 'living', liveStartTime: NOW, roomTitle: TITLE }, NOW);
  assert.strictEqual(r.notify, true);
});
