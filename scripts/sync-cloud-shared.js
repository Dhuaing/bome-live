/**
 * 把 cloudfunctions/_shared/ 同步到每个云函数目录下。
 *
 * 为什么需要：
 * 微信云开发按「目录」独立部署云函数，cloudfunctions/_shared/ 不会随
 * getStreamerStatus 一起上传。若想让多个云函数复用同一份代码，
 * 必须在部署前把共享代码复制进各自的函数目录。
 *
 * 这样源码里只有一份（cloudfunctions/_shared/），
 * 部署产物里的副本由本脚本生成，不手工维护。
 *
 * 用法：node scripts/sync-cloud-shared.js
 *      （已挂在 npm run build:weapp / build:all 前置步骤）
 */
const fs = require('fs');
const path = require('path');

const CF_ROOT = path.join(__dirname, '..', 'cloudfunctions');
const SHARED_DIR = path.join(CF_ROOT, '_shared');
const TARGET_SUBDIR = '_shared';

/** 需要同步共享代码的云函数（按需增删） */
const FUNCTIONS = ['getStreamerStatus', 'getUserFollows', 'toggleFollow', 'watchLive', 'notifyQuota', 'guardian'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listSharedFiles() {
  if (!fs.existsSync(SHARED_DIR)) return [];
  return fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.js'));
}

function syncTo(fnName, files) {
  const target = path.join(CF_ROOT, fnName, TARGET_SUBDIR);
  ensureDir(target);
  for (const file of files) {
    fs.copyFileSync(path.join(SHARED_DIR, file), path.join(target, file));
  }
  return target;
}

function main() {
  const files = listSharedFiles();
  if (files.length === 0) {
    console.log('[sync-cloud-shared] _shared 下没有可同步的文件，跳过');
    return;
  }

  for (const fn of FUNCTIONS) {
    const fnDir = path.join(CF_ROOT, fn);
    if (!fs.existsSync(fnDir)) {
      console.warn(`[sync-cloud-shared] 跳过不存在的云函数：${fn}`);
      continue;
    }
    syncTo(fn, files);
    console.log(`[sync-cloud-shared] ${fn} ← ${files.join(', ')}`);
  }
}

main();
