/**
 * 纯函数单测（Node 内置 test runner，无需额外依赖）。
 *
 * 用法：node --test scripts/
 *     或 npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeUniqueId, isValidUniqueId, buildRoomUrl, resolveRoomUrl } = require('./follow-record');
const { evaluate, formatMessage } = require('../cloudfunctions/_shared/watch-rules');

test('normalizeUniqueId：裸抖音号原样返回', () => {
  assert.strictEqual(normalizeUniqueId('54681081079'), '54681081079');
});

test('normalizeUniqueId：剥离直播间地址前缀', () => {
  assert.strictEqual(normalizeUniqueId('https://live.douyin.com/54681081079'), '54681081079');
  assert.strictEqual(normalizeUniqueId('http://live.douyin.com/abc_123'), 'abc_123');
});

test('normalizeUniqueId：剥离 query / hash / 尾斜杠', () => {
  assert.strictEqual(normalizeUniqueId('https://live.douyin.com/123?foo=1'), '123');
  assert.strictEqual(normalizeUniqueId('https://live.douyin.com/123#top'), '123');
  assert.strictEqual(normalizeUniqueId('https://live.douyin.com/123///'), '123');
});

test('normalizeUniqueId：空值安全', () => {
  assert.strictEqual(normalizeUniqueId(''), '');
  assert.strictEqual(normalizeUniqueId(null), '');
  assert.strictEqual(normalizeUniqueId(undefined), '');
  assert.strictEqual(normalizeUniqueId('   '), '');
});

test('isValidUniqueId：合法与非法', () => {
  assert.ok(isValidUniqueId('54681081079'));
  assert.ok(isValidUniqueId('abc_def-1.2'));
  assert.ok(!isValidUniqueId(''));
  assert.ok(!isValidUniqueId('   '));
  assert.ok(!isValidUniqueId('has space'));
  assert.ok(!isValidUniqueId('bad/slash'));
});

test('buildRoomUrl：由抖音号拼地址', () => {
  assert.strictEqual(buildRoomUrl('123'), 'https://live.douyin.com/123');
  assert.strictEqual(buildRoomUrl(''), '');
});

test('resolveRoomUrl：优先用给定值', () => {
  assert.strictEqual(resolveRoomUrl('https://x.com/1', '123'), 'https://x.com/1');
  assert.strictEqual(resolveRoomUrl('', '123'), 'https://live.douyin.com/123');
  assert.strictEqual(resolveRoomUrl(undefined, '123'), 'https://live.douyin.com/123');
});

test('evaluate：首次见到不推送', () => {
  const r = evaluate(undefined, { status: 'living', liveStartTime: 1000 });
  assert.strictEqual(r.notify, false);
  assert.strictEqual(r.current, 'living');
});

test('evaluate：offline → living 推送', () => {
  const r = evaluate({ status: 'offline', sessionKey: 0 }, { status: 'living', liveStartTime: 5000 });
  assert.strictEqual(r.notify, true);
});

test('evaluate：同一场直播不重复推送', () => {
  const r = evaluate({ status: 'living', sessionKey: 5000 }, { status: 'living', liveStartTime: 5000 });
  assert.strictEqual(r.notify, false);
});

test('evaluate：跳变超过噪声窗但无标题可比（信息缺失）→ fail-open 推送，不漏报真开场', () => {
  const r = evaluate(
    { status: 'living', sessionKey: 5000 },
    { status: 'living', liveStartTime: 5000 + 6 * 60 * 1000 }
  );
  assert.strictEqual(r.notify, true);
});

test('evaluate：living → offline 不推送', () => {
  const r = evaluate({ status: 'living', sessionKey: 5000 }, { status: 'offline' });
  assert.strictEqual(r.notify, false);
});

test('evaluate：offline 时 sessionKey 归零', () => {
  const r = evaluate({ status: 'living', sessionKey: 5000 }, { status: 'offline' });
  assert.strictEqual(r.next.sessionKey, 0);
});

test('formatMessage：包含主播名与直播间地址', () => {
  const msg = formatMessage(
    { uniqueId: '123', name: '测试主播', roomUrl: 'https://live.douyin.com/123' },
    { roomTitle: '标题', viewerCount: 99 }
  );
  assert.ok(msg.includes('测试主播'));
  assert.ok(msg.includes('标题'));
  assert.ok(msg.includes('99'));
  assert.ok(msg.includes('https://live.douyin.com/123'));
});
