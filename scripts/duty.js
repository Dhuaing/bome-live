#!/usr/bin/env node
/**
 * 值班脚本：AI 自我维护的入口（人/AI/计划任务都能跑）。
 *
 * 做 4 件事，全幂等：
 *   1) 本地体检（doctor + 全量测试），任何硬性失败直接标记
 *   2) 尝试经 IDE 的 CDP 读云端自检数据（meta__guardian / meta__incidents /
 *      meta__pacing / meta__metrics）——IDE 未开或窗口忙时安全降级为「待读」
 *   3) 把体检 + 云端读数写成 docs/运维日志/YYYY-MM-DD.md（AI 下次接手先读它）
 *   4) --auto 模式：仅提交运维日志（不动代码），供 Windows 计划任务调用
 *
 * 用法：node scripts/duty.js [--auto]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IS_AUTO = process.argv.includes('--auto');
const now = new Date();
const day = now.toISOString().slice(0, 10);

function sh(cmd, opts = {}) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', cwd: ROOT, ...opts }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message || '') };
  }
}

/** 用 CDP 从 cloudconsolev1 webview 读云端自检数据（可能拿不到 ≠ 失败，是常态） */
function readCloudViaCdp() {
  try {
    const evalHelper = path.join(process.env.TEMP || '', 'opencode', 'cdp-eval.js');
    if (!fs.existsSync(evalHelper)) return { available: false, reason: '无 CDP 助手' };
    const targets = JSON.parse(sh('powershell -NoProfile -Command "(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:9223/json).Content"').out || '[]');
    const hasCloud = targets.some((t) => /cloudconsolev1/.test(t.url || ''));
    if (!hasCloud) return { available: false, reason: '云控制台 webview 未开' };
    const expr = `(async()=>{ const db=window.cloudApi; const read=async c=>{ try{ const r=await db.tcbQueryRecords({envId:'bome-livedongyailongwang-d91c6e8',tableName:'watchState',mgoQuery:JSON.stringify({_id:c}),mgoLimit:5}); return (r&&r.data&&r.data[0])?JSON.parse(r.data[0]):null; }catch(e){ return null; } }; return {guardian:await read('meta__guardian'), incidents:await read('meta__incidents'), pacing:await read('meta__pacing'), metrics:await read('meta__metrics'), orphans:await read('meta__orphans')}; })()`;
    const b64 = Buffer.from(expr).toString('base64');
    const out = sh(`node "${evalHelper}" cloudconsolev1 ${b64}`, { timeout: 60000 });
    const parsed = JSON.parse(String(out.out).trim().slice(String(out.out).indexOf('{')));
    // cdp-eval.js 的返回包了一层 {type, value}——读数在 value 里
    const inner = parsed && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : parsed;
    // 区分「读数成功」与「读失败」：五份文档至少一份拿到才算真读上——
    // 否则全拿到 null 也当成功，会把「读失败」误报成「无事故」（值班报告失真）
    const gotAny = inner && Object.values(inner).some((v) => v && typeof v === 'object');
    if (!gotAny) return { available: false, reason: `CDP 调用通但文档全空（${String(out.out).trim().slice(0, 80)}）` };
    return { available: true, data: inner };
  } catch (e) {
    return { available: false, reason: String(e.message || e).slice(0, 120) };
  }
}

function fmtCloudSection(cloud) {
  if (!cloud || !cloud.available) {
    return `- （云端读数不可用：${(cloud && cloud.reason) || '未知'}——待 IDE 云控制台开启后让 AI 补读）`;
  }
  const d = cloud.data || {};
  const lines = [];
  const g = d.guardian || {};
  if (g.at) {
    lines.push(`- guardian 最近自检：${new Date(g.at).toLocaleString('zh-CN')}，事故 ${g.incidentCount ?? 0} 条`);
  }
  const inc = Array.isArray(d.incidents && d.incidents.list) ? d.incidents.list : [];
  if (inc.length) {
    lines.push(`- 待处理事故（最近 ${inc.slice(0, 5).length} 条 / 共 ${inc.length} 条）：`);
    for (const x of inc.slice(0, 5)) {
      lines.push(`  - [${x.type}] ${x.detail}`);
    }
  } else {
    lines.push('- 待处理事故：无（meta__incidents 空或未产生）');
  }
  const p = d.pacing || {};
  if (p.lastRoundAt) {
    const ageMin = Math.round((Date.now() - Number(p.lastRoundAt)) / 60000);
    lines.push(`- 巡检心跳：${p.lastRoundAt ? `${ageMin} 分钟前（模式 ${p.mode || '?'}，连败 ${p.failStreak || 0}）` : 'never-run'}`);
  }
  const m = d.metrics || {};
  if (m.startedAt) {
    lines.push(`- 上一轮指标：主机 ${m.streamers} / 记录 ${m.records} / 推送 ${m.pushed} / 失败 ${m.failedStreams} / 孤儿 ${m.orphans ?? 'n/a'}`);
  }
  const o = d.orphans || {};
  if (o.count > 0) {
    lines.push(`- ⚠️ 无主关注 ${o.count} 条：${(o.uniqueIds || []).join(', ')}`);
  }
  return lines.join('\n');
}

async function main() {
  const report = [`# 运维日志 ${day}`, '', `_生成于 ${now.toLocaleString('zh-CN')}（duty.js ${IS_AUTO ? '--auto' : '手动'}）_`, ''];

  // 1) 本地体检
  const doctor = sh('node scripts/doctor.js');
  report.push('## 本地体检', '', `- doctor：${doctor.ok ? '✅ 全绿' : '❌ 硬性失败'} ${doctor.ok ? '' : '\n```\n' + doctor.out.trim() + '\n```'}`);
  const tests = sh('npm test');
  const tLine = /tests (\d+)/.exec(tests.out) || [];
  report.push(`- 单测：${tests.ok && tLine[1] ? `✅ ${tLine[1]} 全过` : '❌ 失败（本地手动跑 npm test 看明细）'}`);
  const git = sh('git status --porcelain');
  report.push(`- git 工作区：${git.out.trim() ? `${git.out.trim().split('\n').length} 个未提交变更` : '干净'}`);

  // 2) 云端读数（可能降级）
  report.push('', '## 云端自检', fmtCloudSection(readCloudViaCdp()));

  // 3) 落盘
  const dir = path.join(ROOT, 'docs', '运维日志');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  fs.writeFileSync(file, report.join('\n'));

  // 4) --auto：自动提交这次的日志（避免工作区被报告茬占位）
  if (IS_AUTO) {
    sh(`git add "${path.relative(ROOT, file)}"`);
    sh(`git commit -m "chore(ops): 运维日志 ${day}（自动值班）"`);
  }

  console.log(fs.readFileSync(file, 'utf8'));
  console.log(`\n日志已写：docs/运维日志/${day}.md`);
  // 非零退出仅当硬性失败（CI/计划任务可感知）
  process.exit(doctor.ok && tests.ok ? 0 : 1);
}

main();
