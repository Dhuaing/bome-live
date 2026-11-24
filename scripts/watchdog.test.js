/**
 * watchdog 纯函数单测：守护者的守护者 + 健康度汇总。
 *
 * 为什么值得钉死：
 * - guardian 曾丢掉定时触发器 18 天无人发现（它自己挂了不会知道），
 *   补跑判定错一次就是「要么永远不补，要么每分钟递归互调」
 * - 健康分级直接展示在用户「我的」页，虚报 ok 比不报更糟
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  decideGuardianHeal,
  summarizeHealth,
  STALE_MS,
  HEAL_COOLDOWN_MS,
  HEARTBEAT_DEAD_MIN
} = require('../cloudfunctions/_shared/watchdog');

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const MIN = 60 * 1000;

// ────────────────────────── decideGuardianHeal ──────────────────────────

test('decideGuardianHeal：guardian 从未运行 → 立刻补跑', () => {
  const d = decideGuardianHeal({ now: NOW, guardianAt: 0, lastHealAt: 0 });
  assert.deepStrictEqual(d, { heal: true, reason: 'never-run', ageMs: null });
});

test('decideGuardianHeal：坏数据（非数字）按从未运行处理，不静默放过', () => {
  const d = decideGuardianHeal({ now: NOW, guardianAt: 'oops', lastHealAt: null });
  assert.strictEqual(d.heal, true);
  assert.strictEqual(d.reason, 'never-run');
});

test('decideGuardianHeal：26h 内自检过 → 不打扰（fresh）', () => {
  const d = decideGuardianHeal({ now: NOW, guardianAt: NOW - 2 * H });
  assert.strictEqual(d.heal, false);
  assert.strictEqual(d.reason, 'fresh');
  assert.strictEqual(d.ageMs, 2 * H);
});

test('decideGuardianHeal：边界 26h 整算新鲜（含等号，避免整点抖动误补跑）', () => {
  const d = decideGuardianHeal({ now: NOW, guardianAt: NOW - STALE_MS });
  assert.strictEqual(d.heal, false);
  assert.strictEqual(d.reason, 'fresh');
});

test('decideGuardianHeal：超过 26h 且没补跑过 → 补跑', () => {
  const d = decideGuardianHeal({ now: NOW, guardianAt: NOW - STALE_MS - 1 });
  assert.strictEqual(d.heal, true);
  assert.strictEqual(d.reason, 'stale');
});

test('decideGuardianHeal：停摆但刚补跑过（冷却中）→ 不动，防递归互调与刷调用量', () => {
  // 场景：watchLive 补跑 guardian → guardian 反向补跑 watchLive → 嵌套轮
  // 必须在这里被拦住，否则两个函数互相调用直到超时
  const d = decideGuardianHeal({
    now: NOW,
    guardianAt: NOW - 30 * H,
    lastHealAt: NOW - 5 * MIN
  });
  assert.strictEqual(d.heal, false);
  assert.strictEqual(d.reason, 'cooldown');
});

test('decideGuardianHeal：停摆且冷却已过 → 再次补跑', () => {
  const d = decideGuardianHeal({
    now: NOW,
    guardianAt: NOW - 30 * H,
    lastHealAt: NOW - HEAL_COOLDOWN_MS - 1
  });
  assert.strictEqual(d.heal, true);
  assert.strictEqual(d.reason, 'stale');
});

test('decideGuardianHeal：staleMs / cooldownMs 可注入（测试与调参用）', () => {
  const fresh = decideGuardianHeal(
    { now: NOW, guardianAt: NOW - 10 * MIN },
    { staleMs: 5 * MIN }
  );
  assert.strictEqual(fresh.heal, true);
  const cd = decideGuardianHeal(
    { now: NOW, guardianAt: NOW - 10 * MIN, lastHealAt: NOW - 1 * MIN },
    { staleMs: 5 * MIN, cooldownMs: 2 * MIN }
  );
  assert.strictEqual(cd.heal, false);
  assert.strictEqual(cd.reason, 'cooldown');
});

// ────────────────────────── summarizeHealth ──────────────────────────

const freshPacing = { lastRoundAt: NOW - 1 * MIN, failStreak: 0 };
const freshGuardian = { at: NOW - 2 * H };

test('summarizeHealth：一切正常 → ok，且给出两个年龄', () => {
  const h = summarizeHealth({ now: NOW, pacing: freshPacing, guardian: freshGuardian });
  assert.strictEqual(h.level, 'ok');
  assert.strictEqual(h.ok, true);
  assert.deepStrictEqual(h.reasons, []);
  assert.strictEqual(h.heartbeatAgeMin, 1);
  assert.strictEqual(h.guardianAgeMin, 120);
});

test('summarizeHealth：心跳停摆 25 分钟 → warn（巡检还在，但有异常）', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: { lastRoundAt: NOW - 25 * MIN },
    guardian: freshGuardian
  });
  assert.strictEqual(h.level, 'warn');
  assert.strictEqual(h.reasons.length, 1);
  assert.match(h.reasons[0], /巡检心跳停摆 25 分钟/);
});

test('summarizeHealth：心跳超过 6h → bad（链路整体死亡）', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: { lastRoundAt: NOW - (HEARTBEAT_DEAD_MIN + 1) * MIN },
    guardian: freshGuardian
  });
  assert.strictEqual(h.level, 'bad');
});

test('summarizeHealth：心跳从未出现 → bad + 「巡检从未运行」', () => {
  const h = summarizeHealth({ now: NOW, pacing: null, guardian: freshGuardian });
  assert.strictEqual(h.level, 'bad');
  assert.strictEqual(h.heartbeatAgeMin, null);
  assert.ok(h.reasons.includes('巡检从未运行'));
});

test('summarizeHealth：守护者停摆 27h → 单独成条 reason', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: freshPacing,
    guardian: { at: NOW - 27 * H }
  });
  assert.strictEqual(h.level, 'warn');
  assert.ok(h.reasons.some((r) => /守护者停摆/.test(r)));
});

test('summarizeHealth：连续失败 5 轮 → 计入 reason', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: { lastRoundAt: NOW - 1 * MIN, failStreak: 5 },
    guardian: freshGuardian
  });
  assert.strictEqual(h.level, 'warn');
  assert.ok(h.reasons.some((r) => /连续失败 5 轮/.test(r)));
});

test('summarizeHealth：上次补跑失败 → 计入 reason（不然自动愈合失败会永远静默）', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: freshPacing,
    guardian: freshGuardian,
    watchdog: { lastHealAt: NOW - 10 * MIN, lastHealOk: false }
  });
  assert.strictEqual(h.level, 'warn');
  assert.strictEqual(h.lastHealOk, false);
  assert.ok(h.reasons.some((r) => /补跑失败/.test(r)));
});

test('summarizeHealth：已办（level=resolved）的事故不计入待处理', () => {
  const h = summarizeHealth({
    now: NOW,
    pacing: freshPacing,
    guardian: freshGuardian,
    incidents: {
      list: [
        { type: 'orphans', level: 'resolved' },
        { type: 'fail-streak', level: 'warn' }
      ]
    }
  });
  assert.strictEqual(h.incidentsOpen, 1);
});

test('summarizeHealth：空输入 → bad（不虚报健康）', () => {
  const h = summarizeHealth({ now: NOW });
  assert.strictEqual(h.level, 'bad');
  assert.strictEqual(h.ok, false);
  assert.strictEqual(h.heartbeatAgeMin, null);
  assert.strictEqual(h.guardianAgeMin, null);
});
