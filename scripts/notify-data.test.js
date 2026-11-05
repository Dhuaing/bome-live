/**
 * notify-data 单测（订阅消息 data 构造 + 告警 data 构造）。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  formatTime,
  buildSubsData,
  buildAlertData,
  NOTIFY_SUPPLY,
  ALERT_SUPPLY
} = require('../cloudfunctions/_shared/notify-data');

const INFO = {
  uniqueId: '54681081079',
  nickname: '冻腰',
  roomTitle: '晚间冲分',
  viewerCount: 12345,
  // 用 Date.UTC 构造绝对时刻（= 北京时间 2026-10-31 20:31，Windows CI UTC 上值一致）。
  // 踩过：原先用 new Date(2026,9,31,20,31) 按本地时区构造，Windows(+8) 全绿、
  // Linux UTC 容器上 formatTime 渲染成次日 04:31，四条断言全炸（坑 #7 的测试变体）
  liveStartTime: Date.UTC(2026, 9, 31, 12, 31)
};

test('formatTime：标准输出、无效值空串', () => {
  assert.strictEqual(formatTime(INFO.liveStartTime), '2026-10-31 20:31');
  assert.strictEqual(formatTime(0), '');
  assert.strictEqual(formatTime(-1), '');
  assert.strictEqual(formatTime(NaN), '');
});

test('formatTime：固定按东八区渲染，不随运行环境时区漂移（SCF 容器 UTC 踩坑）', () => {
  // 北京时间 2026-11-02 14:59:00 = UTC 06:59（云函数容器曾错误显示成 06:59）
  const beijingTs = Date.parse('2026-11-02T14:59:00+08:00');
  assert.strictEqual(formatTime(beijingTs), '2026-11-02 14:59');
  // UTC 23:59 应进位到东八区次日 07:59，跨日不穿帮
  const utcLateTs = Date.parse('2026-11-02T23:59:00Z');
  assert.strictEqual(formatTime(utcLateTs), '2026-11-03 07:59');
});

test('buildSubsData：按 keys 映射生成，加 { value } 包装', () => {
  const keys = {
    name: 'thing1',
    roomTitle: 'thing2',
    viewerCount: 'number3',
    liveStartTime: 'time4',
    note: 'thing5'
  };
  const data = buildSubsData(INFO, keys);
  assert.deepStrictEqual(data, {
    thing1: { value: '冻腰' },
    thing2: { value: '晚间冲分' },
    number3: { value: '12345' },
    time4: { value: '2026-10-31 20:31' },
    thing5: { value: '关注的主播开播啦，点进来看' }
  });
});

test('buildSubsData：昵称缺失回退 uniqueId', () => {
  const data = buildSubsData({ ...INFO, nickname: '' }, { name: 'thing1' });
  assert.strictEqual(data.thing1.value, '54681081079');
});

test('buildSubsData：空值字段不出现在 data（模板可选字段留空最稳）', () => {
  const data = buildSubsData({ ...INFO, viewerCount: 0 }, { name: 'thing1', viewerCount: 'number3' });
  assert.deepStrictEqual(data, { thing1: { value: '冻腰' } });
});

test('buildSubsData：超长截断（thing 上限 20 字）', () => {
  const data = buildSubsData({ ...INFO, nickname: '字'.repeat(50) }, { name: 'thing1' });
  assert.strictEqual(data.thing1.value.length, 20);
});

test('buildSubsData：time 字段保留完整时间格式（不按 thing 截断）', () => {
  const data = buildSubsData(INFO, { liveStartTime: 'time3' });
  assert.strictEqual(data.time3.value, '2026-10-31 20:31');
});

test('buildSubsData：keys 为空/未配置时返回空对象（仅巡检不推送）', () => {
  assert.deepStrictEqual(buildSubsData(INFO, undefined), {});
  assert.deepStrictEqual(buildSubsData(INFO, {}), {});
});

test('NOTIFY_SUPPLY 只声明已实现的字段，防键名笔误静默丢弃', () => {
  assert.deepStrictEqual(Object.keys(NOTIFY_SUPPLY).sort(), [
    'liveStartTime', 'name', 'note', 'roomTitle', 'viewerCount'
  ]);
});

test('buildAlertData：告警字段与时间', () => {
  const ctx = { detail: '连续 3 次查询失败：页面结构变更', failedAt: INFO.liveStartTime };
  const data = buildAlertData(ctx, { detail: 'thing1', failedAt: 'time2' });
  assert.deepStrictEqual(data, {
    thing1: { value: '连续 3 次查询失败：页面结构变更' },
    time2: { value: '2026-10-31 20:31' }
  });
});

test('buildAlertData：缺 detail 时不产出该键', () => {
  const data = buildAlertData({ failedAt: INFO.liveStartTime }, { detail: 'thing1' });
  assert.deepStrictEqual(data, {});
});

test('ALERT_SUPPLY 只声明已实现的字段', () => {
  assert.deepStrictEqual(Object.keys(ALERT_SUPPLY).sort(), ['detail', 'failedAt']);
});

test('watch-config.json 的字段映射必须配得上实际取值器（防键名笔误静默丢字段）', () => {
  // 需要访问 fs/path，单独引入
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'cloudfunctions', 'watchLive', 'watch-config.json'),
      'utf8'
    )
  );

  const known = { ...NOTIFY_SUPPLY, ...ALERT_SUPPLY };
  for (const [source, section] of [
    [cfg.keys, 'keys'],
    [cfg.alertKeys, 'alertKeys']
  ]) {
    assert.ok(source, `watch-config.json 缺少 ${section}`);
    for (const field of Object.keys(source)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(known, field),
        `${section}.${field} 在 notify-data.js 的取值器里不存在，请核对字段名拼写`
      );
    }
  }
  // 注：templateId 留空 + keys 预填默认映射是有意的引导状态——
  // 开发者从模板库拿到模板后只需填 templateId 一个字段。
  // 这里只校验字段名拼写，不校验配置完整度。
});
