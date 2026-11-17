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

// ─────────────────────────────────────────────────────────────
// commitEvent 原子写路径（fake db，钉死 2026-11-17 加固后的语义：
// 数据库端原子 inc / 条件扣减 / 不存在与读失败严格区分）
// ─────────────────────────────────────────────────────────────

const { commitEvent } = require('../cloudfunctions/_shared/quota-ledger');

/** 最小 fake 云数据库：只实现 commitEvent 用到的 doc/add/where/inc/gt 语义 */
function makeDb(seed = {}) {
  const store = new Map(); // `${coll}/${id}` -> doc
  for (const [coll, docs] of Object.entries(seed)) {
    for (const [id, doc] of Object.entries(docs)) store.set(`${coll}/${id}`, { ...doc });
  }
  const command = {
    inc: (d) => ({ __op: 'inc', d }),
    gt: (d) => ({ __op: 'gt', d }),
    exists: () => ({ __op: 'exists' })
  };

  function applyUpdate(doc, data) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && v.__op === 'inc') {
        doc[k] = (Number(doc[k]) || 0) + v.d;
      } else {
        doc[k] = v;
      }
    }
  }

  function matchCond(doc, cond) {
    for (const [field, want] of Object.entries(cond)) {
      if (want && typeof want === 'object' && want.__op === 'gt') {
        if (!((Number(doc[field]) || 0) > want.d)) return false;
      } else if (doc[field] !== want) {
        return false;
      }
    }
    return true;
  }

  function collection(name) {
    const key = (id) => `${name}/${id}`;
    // 按名缓存 coll：同一集合多次 collection() 拿同一对象（测试需在
    // 同一实例上覆写方法来模拟读失败）
    cache[name] = cache[name] || { _docs: {} };
    const entry = cache[name];
    if (!entry.add) {
      entry.add = async ({ data }) => {
        if (store.has(key(data._id))) {
          const e = new Error('document.add:fail document already exists');
          e.errMsg = e.message;
          throw e;
        }
        store.set(key(data._id), { ...data });
        return { _id: data._id };
      };
      entry.doc = (id) => {
        entry._docs[id] = entry._docs[id] || {
          get: async () => {
            const doc = store.get(key(id));
            if (!doc) {
              const e = new Error('document.get:fail document not exists');
              e.errMsg = e.message;
              throw e;
            }
            return { data: { ...doc } };
          },
          update: async ({ data }) => {
            const doc = store.get(key(id));
            if (!doc) return { stats: { updated: 0 } }; // 坑 #6：缺失文档静默空操作
            applyUpdate(doc, data);
            return { stats: { updated: 1 } };
          }
        };
        return entry._docs[id];
      };
      entry.where = (cond) => ({
        update: async ({ data }) => {
          let updated = 0;
          for (const [k, doc] of store) {
            if (!k.startsWith(`${name}/`)) continue;
            if (!matchCond(doc, cond)) continue;
            applyUpdate(doc, data);
            updated += 1;
          }
          return { stats: { updated } };
        }
      });
    }
    return entry;
  }

  const cache = {};
  return { collection, command, store };
}

test('commitEvent spend：条件原子扣减，余额 2 扣到 1', async () => {
  const db = makeDb({ subs: { u1: { _id: 'u1', quota: 2, totalEarned: 5, totalSpent: 3 } } });
  const next = await commitEvent(db, 'subs', 'u1', { type: 'spend' });
  assert.strictEqual(next.quota, 1);
  assert.strictEqual(next.totalSpent, 4);
  assert.strictEqual(next.totalEarned, 5);
});

test('commitEvent spend：余额 0 扣不到负，只记累计（宁虚低）', async () => {
  const db = makeDb({ subs: { u1: { _id: 'u1', quota: 0, totalEarned: 5, totalSpent: 5 } } });
  const next = await commitEvent(db, 'subs', 'u1', { type: 'spend' });
  assert.strictEqual(next.quota, 0);
  assert.strictEqual(next.totalSpent, 6);
});

test('commitEvent spend：文档不存在 → 建档 quota 0 / totalSpent 1', async () => {
  const db = makeDb();
  const next = await commitEvent(db, 'subs', 'u1', { type: 'spend' });
  assert.deepStrictEqual({ quota: next.quota, totalEarned: next.totalEarned, totalSpent: next.totalSpent }, {
    quota: 0, totalEarned: 0, totalSpent: 1
  });
});

test('commitEvent earn：全新账本 add 首档（1/1/0）', async () => {
  const db = makeDb();
  const next = await commitEvent(db, 'subs', 'u1', { type: 'earn' });
  assert.deepStrictEqual({ quota: next.quota, totalEarned: next.totalEarned, totalSpent: next.totalSpent }, {
    quota: 1, totalEarned: 1, totalSpent: 0
  });
});

test('commitEvent earn：已存在 → 原子 inc 不覆盖', async () => {
  const db = makeDb({ subs: { u1: { _id: 'u1', quota: 3, totalEarned: 3, totalSpent: 1 } } });
  const next = await commitEvent(db, 'subs', 'u1', { type: 'earn' });
  assert.strictEqual(next.quota, 4);
  assert.strictEqual(next.totalEarned, 4);
  assert.strictEqual(next.totalSpent, 1);
});

test('commitEvent zero：已存在 → 余额归零并留校准时间戳', async () => {
  const db = makeDb({ subs: { u1: { _id: 'u1', quota: 7, totalEarned: 7, totalSpent: 0 } } });
  const next = await commitEvent(db, 'subs', 'u1', { type: 'zero', at: 1234 });
  assert.strictEqual(next.quota, 0);
  assert.strictEqual(next.correctedAt, 1234);
  assert.strictEqual(next.totalSpent, 0);
});

test('commitEvent zero：文档不存在 → 建档全 0', async () => {
  const db = makeDb();
  const next = await commitEvent(db, 'subs', 'u1', { type: 'zero', at: 1234 });
  assert.strictEqual(next.quota, 0);
  assert.strictEqual(next.correctedAt, 1234);
});

test('commitEvent：读失败（非「不存在」）必须抛错，绝不静默用空账本顶替', async () => {
  const db = makeDb();
  // 模拟瞬时网络故障：get 抛非 not-exists 错误
  db.collection('subs').doc('u1').get = async () => {
    const e = new Error('network timeout');
    e.errMsg = 'network timeout';
    throw e;
  };
  await assert.rejects(() => commitEvent(db, 'subs', 'u1', { type: 'spend' }), /network timeout/);
});

test('commitEvent：未知事件类型抛错（不再静默不动账本）', async () => {
  const db = makeDb({ subs: { u1: { _id: 'u1', quota: 1, totalEarned: 1, totalSpent: 0 } } });
  await assert.rejects(() => commitEvent(db, 'subs', 'u1', { type: 'mystery' }), /未知账本事件/);
});
