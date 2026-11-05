#!/usr/bin/env node
/**
 * 一键体检：AI 代理（或人）接手项目后的热启动诊断。
 *
 * 检查项（全部本地，不需要 IDE/网络）：
 *   1) watch-config.json 结构：templateId、字段映射与取值器对齐、pacing 合法
 *   2) 共享代码同步：_shared/ 源与各函数目录副本无漂移
 *   3) 构建产物：dist-weapp 存在且注入了环境 ID / 模板 ID（坑 #5）
 *   4) 关键脚本引用完好（sync 在 build:weapp 前置）
 *   5) git 工作区干净度（只提示，不算失败）
 *
 * 退出码：0 全绿；1 有必须处理的项（sync 漂移 / 配置坏 / 产物缺注入）。
 * 用法：node scripts/doctor.js [--full]   --full 追加 npm test
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions');
const results = [];
let hardFail = 0;

function record(name, ok, detail, hard) {
  results.push({ name, ok, detail });
  if (!ok && hard) hardFail += 1;
}

function sha(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (e) {
    return 'MISSING';
  }
}

// 1. watch-config.json
(function checkWatchConfig() {
  const file = path.join(CF, 'watchLive', 'watch-config.json');
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    record('watch-config.json', false, `解析失败：${e.message}`, true);
    return;
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(cfg.templateId || '')) {
    record('watch-config templateId', false, `模板 ID 格式可疑：${cfg.templateId}`, true);
  } else {
    record('watch-config templateId', true, `${cfg.templateId.slice(0, 8)}…`);
  }
  const supply = require(path.join(ROOT, 'cloudfunctions', '_shared', 'notify-data.js')).NOTIFY_SUPPLY;
  const bad = Object.entries(cfg.keys || {}).filter(([biz]) => !supply[biz]);
  if (bad.length) {
    record('watch-config keys', false, `映射引用了不存在的取值器：${bad.map(([b]) => b).join(',')}`, true);
  } else {
    record(
      'watch-config keys',
      true,
      Object.entries(cfg.keys || {}).map(([b, k]) => `${b}→${k}`).join(' ')
    );
  }
  const p = cfg.pacing || {};
  const badPacing = ['idleMinutes', 'failMinutes', 'activeMinutes'].some(
    (k) => k in p && (!Number.isFinite(Number(p[k])) || Number(p[k]) < 1)
  );
  record('watch-config pacing', !badPacing, badPacing ? '含非法分钟数（须 >=1 的数字）' : `idle=${p.idleMinutes ?? 2}/fail=${p.failMinutes ?? 2}/active=${p.activeMinutes ?? 1}（缺省用默认）`, true);
})();

// 2. 共享代码同步漂移
(function checkSharedSync() {
  const sharedDir = path.join(CF, '_shared');
  const sharedFiles = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.js'));
  const functions = fs
    .readdirSync(CF)
    .filter((d) => fs.statSync(path.join(CF, d)).isDirectory() && fs.existsSync(path.join(CF, d, 'index.js')));
  const drifts = [];
  for (const fn of functions) {
    for (const f of sharedFiles) {
      const src = path.join(sharedDir, f);
      const copy = path.join(CF, fn, '_shared', f);
      if (sha(src) !== sha(copy)) drifts.push(`${fn}/_shared/${f}`);
    }
  }
  record(
    '共享代码同步',
    drifts.length === 0,
    drifts.length ? `漂移：${drifts.slice(0, 6).join('、')}…（跑 node scripts/sync-cloud-shared.js）` : `${sharedFiles.length} 个共享文件 × ${functions.length} 个函数 全一致`,
    true
  );
})();

// 3. 构建产物注入检查
(function checkDist() {
  const root = path.join(ROOT, 'dist-weapp');
  const app = path.join(root, 'app.js');
  if (!fs.existsSync(app)) {
    record('dist-weapp', false, '产物不存在（npm run build:weapp）', false);
    return;
  }
  const envId = 'bome-livedongyailongwang-d91c6e8';
  const tmplId = 'N923NAse66knou';
  const tmplDir = path.join(root, 'pages', 'subscribe');
  const tmplFound = fs.existsSync(tmplDir) && fs
    .readdirSync(tmplDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => fs.readFileSync(path.join(tmplDir, f), 'utf8').includes(tmplId));
  // 环境 ID 由 defineConstants 打进共享 chunk（common.js），不在 app.js 本体
  const envHasId = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.js') && /common/i.test(f))
    .some((f) => fs.readFileSync(path.join(root, f), 'utf8').includes(envId));
  record(
    'dist-weapp 注入',
    envHasId && tmplFound,
    envHasId && tmplFound
      ? '环境 ID + 模板 ID 均在'
      : `缺失：${!envHasId ? '环境 ID ' : ''}${!tmplFound ? '模板 ID ' : ''}——用显式 env 重新 build:weapp（坑 #5）`,
    true
  );
})();

// 4. 构建前置依赖
(function checkBuildChain() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const build = pkg.scripts['build:weapp'] || '';
  const hasSync = build.includes('sync:cloud') || build.includes('sync-cloud-shared');
  record('build:weapp 前置同步', hasSync, hasSync ? build : `缺少 sync 前置：${build}`, true);
})();

// 5. git 状态（提示级）
(function checkGit() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const n = out.split('\n').filter(Boolean).length;
    record('git 工作区', true, n ? `${n} 个未提交变更` : '干净', false);
  } catch (e) {
    record('git 工作区', false, 'git 不可用或非仓库', false);
  }
})();

for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.detail}`);
}
console.log(hardFail === 0 ? '\n全部硬性检查通过。' : `\n${hardFail} 项硬性检查未过，先处理再继续。`);
process.exit(hardFail === 0 ? 0 : 1);
