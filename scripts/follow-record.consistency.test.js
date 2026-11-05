/**
 * 验证三份生成的 follow-record 实现行为完全一致。
 *
 * 这是「规则单一真相」的保障：只要三份实现跑出不同结果，
 * 就说明生成器有 bug，或有人手改了生成物。
 *
 * 用法：node --test scripts/follow-record.consistency.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const cjs = require('./follow-record');
const cloud = require('../cloudfunctions/_shared/follow-record');

/** 覆盖各种边界输入 */
const CASES = [
  ['正常', { uniqueId: '123', name: '主播', avatar: 'https://a.com/x.png', roomUrl: 'https://live.douyin.com/123' }],
  ['空对象', {}],
  ['超长名', { uniqueId: '123', name: 'x'.repeat(500) }],
  ['javascript 协议', { uniqueId: '123', avatar: 'javascript:alert(1)', roomUrl: 'javascript:alert(2)' }],
  ['data 协议', { uniqueId: '123', avatar: 'data:text/html,x' }],
  ['控制字符', { uniqueId: '123', name: 'a\u0000b\u0007c' }],
  ['空字符串', { uniqueId: '123', name: '', avatar: '', roomUrl: '' }],
  ['null 字段', { uniqueId: '123', name: null, avatar: null, roomUrl: null }],
  ['带空格', { uniqueId: '  123  ', name: '  名字  ' }]
];

test('cleanText / cleanUrl 三份实现一致', () => {
  for (const [label, input] of CASES) {
    assert.strictEqual(
      cjs.cleanText(input.name, cjs.MAX_NAME),
      cloud.cleanText(input.name, cloud.MAX_NAME),
      `cleanText 不一致: ${label}`
    );
    assert.strictEqual(
      cjs.cleanUrl(input.avatar),
      cloud.cleanUrl(input.avatar),
      `cleanUrl 不一致: ${label}`
    );
  }
});

test('isValidUniqueId 三份实现一致', () => {
  const ids = ['123', '', '  ', 'abc_def-1.2', 'has space', 'bad/slash', null, undefined];
  for (const id of ids) {
    assert.strictEqual(
      cjs.isValidUniqueId(id),
      cloud.isValidUniqueId(id),
      `isValidUniqueId 不一致: ${JSON.stringify(id)}`
    );
  }
});

test('buildRoomUrl / resolveRoomUrl 三份实现一致', () => {
  assert.strictEqual(cjs.buildRoomUrl('123'), cloud.buildRoomUrl('123'));
  assert.strictEqual(cjs.buildRoomUrl(''), cloud.buildRoomUrl(''));
  assert.strictEqual(
    cjs.resolveRoomUrl('https://x.com/1', '123'),
    cloud.resolveRoomUrl('https://x.com/1', '123')
  );
  assert.strictEqual(cjs.resolveRoomUrl('', '123'), cloud.resolveRoomUrl('', '123'));
});

test('buildFollowRecord 三份实现一致（固定时间戳）', () => {
  const NOW = 1700000000000;
  for (const [label, input] of CASES) {
    assert.deepStrictEqual(
      cjs.buildFollowRecord(input, null, NOW),
      cloud.buildFollowRecord(input, null, NOW),
      `buildFollowRecord 不一致: ${label}`
    );
  }
});

test('buildFollowRecord 更新时保留旧值', () => {
  const NOW = 1700000000000;
  const existing = {
    uniqueId: '123',
    name: '旧名字',
    avatar: 'https://old.com/a.png',
    roomUrl: 'https://live.douyin.com/123',
    createdAt: 1600000000000
  };
  // 只传 uniqueId，其余应保留旧值
  const rec = cjs.buildFollowRecord({ uniqueId: '123' }, existing, NOW);
  assert.strictEqual(rec.name, '旧名字');
  assert.strictEqual(rec.avatar, 'https://old.com/a.png');
  assert.strictEqual(rec.createdAt, 1600000000000, 'createdAt 不应被覆盖');
  assert.strictEqual(rec.updatedAt, NOW);
});

test('常量三份一致', () => {
  assert.strictEqual(cjs.MAX_NAME, cloud.MAX_NAME);
  assert.strictEqual(cjs.MAX_URL, cloud.MAX_URL);
  assert.deepStrictEqual(cjs.ACTIONS, cloud.ACTIONS);
});
