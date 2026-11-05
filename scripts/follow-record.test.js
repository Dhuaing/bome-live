/**
 * follow-record 附加健壮性测试：确定性主键（buildFollowDocId）。
 * 堵死并发双插的根基：同（openid, uniqueId）永远生成同一条 _id。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { buildFollowDocId } = require('../cloudfunctions/_shared/follow-record');

test('同（openid, uniqueId）永远生成同一个 _id（并发双插的基础保障）', () => {
  const a = buildFollowDocId('oHM8XxqrABC', '54681081079');
  const b = buildFollowDocId('oHM8XxqrABC', '54681081079');
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'oHM8XxqrABC__54681081079');
});

test('不同用户/不同主播的 _id 必然不同（隔离不被破坏）', () => {
  const user1 = buildFollowDocId('openid_A', '123');
  const user2 = buildFollowDocId('openid_B', '123');
  const other = buildFollowDocId('openid_A', '456');
  assert.notStrictEqual(user1, user2);
  assert.notStrictEqual(user1, other);
});

test('坏输入容错：trim 空白并处理 null/undefined 不炸', () => {
  assert.strictEqual(buildFollowDocId(' a ', ' b '), 'a__b');
  assert.strictEqual(buildFollowDocId('x', ''), 'x__');
  assert.strictEqual(buildFollowDocId('', 'y'), '__y');
  assert.strictEqual(buildFollowDocId(null, undefined), '__');
});
