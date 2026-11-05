/**
 * quota-ledger 纯函数单测：订阅额度账本的事件推演逻辑。
 *
 * 规则核心：展示宁虚低不虚高——
 * - earn/spend/zero 事件对余额的推演结果钉死
 * - 账本偏低时 spend 扣不到负数
 * - 账本虚高时 zero 归零校准并留时间戳
 * - 坏数据容错（null/NaN/负数/超大数）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { applyLedgerEvent } = require('../cloudfunctions/_shared/quota-ledger');

const AT = 1_800_000_000_000;

test('earn：余额 +1，累计攒 +1（全新账本首挣）', () => {
  const next = applyLedgerEvent(undefined, { type: 'earn', at: AT });
  assert.deepStrictEqual(next, { quota: 1, totalEarned: 1, totalSpent: 0 });
});

test('earn：连续两次攒 → 余额 2/累计攒 2', () => {
  const n1 = applyLedgerEvent(undefined, { type: 'earn', at: AT });
  const n2 = applyLedgerEvent(n1, { type: 'earn', at: AT + 1 });
  assert.strictEqual(n2.quota, 2);
  assert.strictEqual(n2.totalEarned, 2);
});

test('spend：余额 -1、累计推 +1；余额是 0 时扣到 0 不到负（宁虚低）', () => {
  const base = { quota: 3, totalEarned: 5, totalSpent: 2 };
  const next = applyLedgerEvent(base, { type: 'spend' });
  assert.deepStrictEqual(next, { quota: 2, totalEarned: 5, totalSpent: 3 });
  // 账本偏低（虚低）时平台侧实际还有，扣不到负数
  const zeroed = applyLedgerEvent({ quota: 0, totalEarned: 5, totalSpent: 5 }, { type: 'spend' });
  assert.deepStrictEqual(zeroed, { quota: 0, totalEarned: 5, totalSpent: 6 });
});

test('zero：43101 校准把虚高余额归零并留时间戳（演示向上漏记的兜底）', () => {
  const inflated = { quota: 7, totalEarned: 7, totalSpent: 0 };
  const next = applyLedgerEvent(inflated, { type: 'zero', at: AT });
  assert.strictEqual(next.quota, 0);
  assert.strictEqual(next.correctedAt, AT);
  // totalSpent 不虚涨（平台没扣，只是账本错了）
  assert.strictEqual(next.totalSpent, 0);
});

test('坏数据容错：NaN/负数/字符串数字按 0 处理，不炸不虚高', () => {
  assert.deepStrictEqual(
    applyLedgerEvent({ quota: NaN, totalEarned: -3, totalSpent: 'x' }, { type: 'spend' }),
    { quota: 0, totalEarned: 0, totalSpent: 1 }
  );
  assert.deepStrictEqual(
    applyLedgerEvent({ quota: '2.7' }, { type: 'spend' }),
    { quota: 1, totalEarned: 0, totalSpent: 1 }
  );
});

test('未知事件不动账本（防御性）', () => {
  const base = { quota: 4, totalEarned: 6, totalSpent: 2 };
  assert.deepStrictEqual(applyLedgerEvent(base, { type: 'mystery' }), {
    quota: 4,
    totalEarned: 6,
    totalSpent: 2
  });
  assert.deepStrictEqual(applyLedgerEvent(base, undefined), {
    quota: 4,
    totalEarned: 6,
    totalSpent: 2
  });
});

test('浮点余额截断为整数（额度只有整数条）', () => {
  const next = applyLedgerEvent({ quota: 2.5, totalEarned: 2.5 }, { type: 'spend' });
  assert.strictEqual(next.quota, 1); // 入口先 floor(2.5)=2，再扣 1
  assert.strictEqual(next.totalEarned, 2);
});
