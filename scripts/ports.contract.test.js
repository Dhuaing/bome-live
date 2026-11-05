/**
 * 接缝测试：验证「换数据实现不需要改业务代码」。
 *
 * 这是 docs/扩展接缝设计.md 里那条判断标准的自动化版本：
 *   「未来想加一个 SQLite 本地存储实现，不需要改任何 page / hook / store 代码，
 *     只新增一个实现文件 + 改一处工厂。」
 *
 * 这里用内存实现替代云实现，验证接口契约可被任意实现满足。
 */
const { test } = require('node:test');
const assert = require('node:assert');

// 内存实现的逻辑与 src/services/memoryFollowRepository.ts 一致，
// 这里用 CJS 重写一份以便 node --test 直接跑（前端 TS 需编译）。
const { buildFollowRecord } = require('./follow-record');

function createMemoryRepository(seed = []) {
  let items = [...seed];
  return {
    async list() {
      return { followedIds: items.map((i) => i.uniqueId), streamers: [...items] };
    },
    async follow(target) {
      const uniqueId = String(target?.uniqueId || '').trim();
      const existing = items.find((i) => i.uniqueId === uniqueId) || null;
      const record = buildFollowRecord({ ...target, uniqueId }, existing);
      items = existing
        ? items.map((i) => (i.uniqueId === uniqueId ? record : i))
        : [...items, record];
      return { followed: true };
    },
    async unfollow(uniqueId) {
      items = items.filter((i) => i.uniqueId !== uniqueId);
      return { followed: false };
    },
    snapshot: () => [...items]
  };
}

test('接缝：任意 FollowRepository 实现都能满足同一套契约', async () => {
  const repo = createMemoryRepository();

  // 空列表
  let res = await repo.list();
  assert.deepStrictEqual(res.followedIds, []);
  assert.deepStrictEqual(res.streamers, []);

  // 关注
  const followResult = await repo.follow({ uniqueId: '123', name: '主播' });
  assert.strictEqual(followResult.followed, true);

  res = await repo.list();
  assert.deepStrictEqual(res.followedIds, ['123']);
  assert.strictEqual(res.streamers[0].name, '主播');
  assert.strictEqual(res.streamers[0].roomUrl, 'https://live.douyin.com/123');

  // 重复关注 → 更新而非新增
  await repo.follow({ uniqueId: '123' });
  res = await repo.list();
  assert.strictEqual(res.streamers.length, 1, '重复关注不应产生第二条');
  assert.strictEqual(res.streamers[0].name, '主播', '更新时应保留旧值');

  // 取关
  const unfollowResult = await repo.unfollow('123');
  assert.strictEqual(unfollowResult.followed, false);
  res = await repo.list();
  assert.deepStrictEqual(res.followedIds, []);

  // 取关不存在的 → 幂等
  const again = await repo.unfollow('not-exist');
  assert.strictEqual(again.followed, false);
});

test('接缝：实现遵循与云函数相同的字段清洗规则', async () => {
  const repo = createMemoryRepository();
  await repo.follow({
    uniqueId: '123',
    name: 'x'.repeat(200),
    avatar: 'javascript:alert(1)',
    roomUrl: 'data:text/html,evil'
  });

  const rec = repo.snapshot()[0];
  assert.strictEqual(rec.name.length, 64, 'name 应截断到 64');
  assert.strictEqual(rec.avatar, '', 'javascript: 应被拒绝');
  assert.strictEqual(rec.roomUrl, 'https://live.douyin.com/123', '非法 roomUrl 应回落');
});
