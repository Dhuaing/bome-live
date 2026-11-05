const { test } = require('node:test');
const assert = require('node:assert');
const { decideCooldownMinutes } = require('../cloudfunctions/_shared/pacing');

test('pacing：有主播在播 → 分钟级（activeMinutes）', () => {
  assert.strictEqual(decideCooldownMinutes({ anyLiving: true, anyFailed: false }, {}), 1);
});

test('pacing：全员离线 → 冷却 idleMinutes，开播提醒延迟上限即其值', () => {
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: false }, {}), 2);
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: false, anyFailed: false }, { idleMinutes: 5 }),
    5
  );
});

test('pacing：查询失败 → 退避取 idle/fail 的较大者', () => {
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true }, {}), 2);
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: false, anyFailed: true }, { idleMinutes: 2, failMinutes: 5 }),
    5
  );
  // 失败优先级高于 idle 但不高于 living：正在播却失败时保实时优先
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: true, anyFailed: true }, { failMinutes: 9 }),
    1
  );
});

test('pacing：配置坏值全部回退默认，且上限 30 分钟防手误停摆', () => {
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: false, anyFailed: false }, { idleMinutes: 'abc' }),
    2
  );
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: false, anyFailed: false }, { idleMinutes: 0 }),
    2
  );
  assert.strictEqual(
    decideCooldownMinutes({ anyLiving: false, anyFailed: false }, { idleMinutes: 9999 }),
    30
  );
  // 无配置对象也安全
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: false }, null), 2);
});

test('pacing：连续失败指数退避（自愈策略：抖动仅多等一分钟，持续故障自动减速）', () => {
  // 首败 failStreak=1 → 2min；二连 → 4min；三连 → 8min；四连 → 16min
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 1 }, {}), 4);
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 2 }, {}), 8);
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 3 }, {}), 16);
  // 封顶：五连及以上 ×8=16…总数封 30min
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 5 }, {}), 30);
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 99 }, {}), 30);
  // 恢复：有任何一轮没失败 → streak 清零回流常规
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true, failStreak: 0 }, {}), 2);
  // failStreak 缺省不影响旧语义（failMinutes 兜底）
  assert.strictEqual(decideCooldownMinutes({ anyLiving: false, anyFailed: true }, {}), 2);
});
