#!/usr/bin/env node
/**
 * 值班脚本：AI 自我维护的入口（人/AI/计划任务都能跑）。
 *
 * 做 4 件事，全幂等：
 *   1) 本地体检（doctor + 全量测试），任何硬性失败直接标记
 *   2) 读云端自检数据（meta__guardian / meta__incidents / meta__pacing /
 *      meta__metrics / meta__orphans）——双通道：优先模拟器调 metaReader
 *      云函数，失败回退 CDP 驱动云控制台；都没有则安全降级为「待读」
 *   3) 把体检 + 云端读数写成 docs/运维日志/YYYY-MM-DD.md（AI 下次接手先读它）
 *   4) --auto 模式：仅提交运维日志（不动代码），供 Windows 计划任务调用
 *
 * 用法：node scripts/duty.js [--auto]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
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

/**
 * 读 IDE CDP (9223) 的 target 列表。
 * 用 node 原生 http（不走系统代理、失败返回 null 而非报错文本）。
 * 历史坑：旧实现用 PowerShell Invoke-WebRequest——一是会吃系统死代理
 * 127.0.0.1:7890（坑位表 IDE 代理坑），二是失败文本 "Invoke-WebRequest : ..."
 * 混进输出被 JSON.parse 后报 "Unexpected token 'I'"，把真实原因（IDE 未运行）
 * 洗成了乱码。
 */
function getCdpTargets() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 9223, path: '/json', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * 云端读数（双通道）：
 *   ① 首选：模拟器 appservice 里 wx.cloud.callFunction('metaReader')——
 *      不依赖云控制台 webview（它经常没开），IDE 项目开着即可读；
 *   ② 回退：CDP 驱动 cloudconsolev1 webview（历史通道，保留）。
 * 拿不到 ≠ 失败，是常态（值班日志如实降级）。
 */
async function readCloudViaProbe() {
  try {
    let evalHelper = path.join(ROOT, 'scripts', 'cdp-eval.js');
    if (!fs.existsSync(evalHelper)) {
      evalHelper = path.join(process.env.TEMP || '', 'opencode', 'cdp-eval.js');
      if (!fs.existsSync(evalHelper)) return { available: false, reason: '无 CDP 助手' };
    }
    const targets = await getCdpTargets();
    if (!targets) return { available: false, reason: 'IDE CDP(9223) 未响应（IDE 未运行）' };
    const hasSim = targets.some((t) => /simulator-app-session/.test(t.url || ''));
    if (!hasSim) return { available: false, reason: '模拟器 appservice 未开' };
    const expr = `(async()=>{ const r=await wx.cloud.callFunction({name:'metaReader',data:{}}); return r.result; })()`;
    const b64 = Buffer.from(expr).toString('base64');
    const out = sh(`node "${evalHelper}" simulator-app-session ${b64}`, { timeout: 60000 });
    const parsed = JSON.parse(String(out.out).trim().slice(String(out.out).indexOf('{')));
    const j = parsed && typeof parsed.value === 'object' ? parsed.value : parsed;
    const d = j && j.data;
    if (!d || typeof d !== 'object') return { available: false, reason: `metaReader 应答异常（${j && j.message || 'no-data'}）` };
    return { available: true, data: d };
  } catch (e) {
    return { available: false, reason: String(e.message || e).slice(0, 120) };
  }
}

/** 用 CDP 从 cloudconsolev1 webview 读云端自检数据（可能拿不到 ≠ 失败，是常态） */
async function readCloudViaCdp() {
  try {
    // 助手收进仓库（旧版放 %TEMP% 会被系统清理，坑位 #13），找不到时回退临时目录
    let evalHelper = path.join(ROOT, 'scripts', 'cdp-eval.js');
    if (!fs.existsSync(evalHelper)) {
      evalHelper = path.join(process.env.TEMP || '', 'opencode', 'cdp-eval.js');
      if (!fs.existsSync(evalHelper)) return { available: false, reason: '无 CDP 助手' };
    }
    const targets = await getCdpTargets();
    if (!targets) return { available: false, reason: 'IDE CDP(9223) 未响应（IDE 未运行）' };
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
    return `- （云端读数不可用：${(cloud && cloud.reason) || '未知'}——待 IDE（模拟器/云控制台）开启后让 AI 补读）`;
  }
  const d = cloud.data || {};
  const lines = [];
  const g = d.guardian || {};
  if (g.at) {
    lines.push(`- guardian 最近自检：${new Date(g.at).toLocaleString('zh-CN')}，事故 ${g.incidentCount ?? 0} 条`);
  }
  const incAll = Array.isArray(d.incidents && d.incidents.list) ? d.incidents.list : [];
  // level==='resolved' 是已办记录（人工认领/修复后标注），不算待处理，别每天重播
  const inc = incAll.filter((x) => x && x.level !== 'resolved');
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

/** 保留上一次写入的人工段（`## 今日处置` / `## 人工处置`）——自动值班重写日志时不能把人工记录冲掉 */
function keepManualSections(prev) {
  if (!prev) return ''
  const parts = prev.split(/^(?=## )/m)
  const kept = parts.filter((s) => /^## (今日处置|人工处置)/.test(s)).map((s) => s.trimEnd())
  return kept.length ? '\n' + kept.join('\n\n') + '\n' : ''
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

  // 2) 云端读数（可能降级）：优先 metaReader 探针，失败回退云控制台 CDP
  const probed = await readCloudViaProbe();
  const cloud = probed.available ? probed : await readCloudViaCdp();
  report.push('', '## 云端自检', fmtCloudSection(cloud));

  // 3) 落盘
  const dir = path.join(ROOT, 'docs', '运维日志');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  let prev = '';
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch (e) {
    prev = ''; // 当天首跑：没有旧文件
  }
  fs.writeFileSync(file, report.join('\n') + keepManualSections(prev));

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
