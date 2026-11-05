/**
 * 校验生成物与规则源同步（CI 用）。
 *
 * 背景：shared/follow-rules.json 会生成三份代码，
 * 如果有人直接手改生成物、或改了规则忘了重跑 gen:rules，
 * 三份实现就会悄悄分叉。
 *
 * 本脚本重跑生成器，检查是否有文件发生变化：
 * - 有变化 → 说明生成物不是最新的，退出码 1
 * - 无变化 → 通过
 *
 * 用法：npm run check:rules
 */
const { execFileSync } = require('child_process');
const path = require('path');

const GEN = path.join(__dirname, 'generate-follow-rules.js');

try {
  const out = execFileSync(process.execPath, [GEN], { encoding: 'utf8' });
  // 生成器输出 "已更新 xxx" 表示有文件被改动
  const updated = out.split('\n').filter((l) => l.includes('已更新'));

  if (updated.length > 0) {
    console.error('[check:rules] 生成物与 shared/follow-rules.json 不同步：');
    for (const line of updated) console.error('  ' + line.trim());
    console.error('\n请运行 npm run gen:rules 并提交生成结果。');
    process.exit(1);
  }
  console.log('[check:rules] 生成物与规则源一致');
} catch (e) {
  console.error('[check:rules] 生成器执行失败:', e.message);
  process.exit(1);
}
