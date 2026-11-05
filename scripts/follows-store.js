/**
 * 关注列表本地存储（唯一真源）
 * 同时被 serve-h5.js（网页读写）和 watch-live.js（巡检读取）使用，
 * 保证网页上关注的主播，巡检脚本能立刻读到。
 *
 * 数据安全约定（重要）：
 * 1. readFollows() 区分「文件不存在」和「文件损坏」。
 *    文件不存在 → 合法的空列表；文件损坏 → 抛错，绝不返回 []。
 *    否则一次瞬时解析失败 + 一次取关，就会把整个列表覆写成 []。
 * 2. 每次覆盖前先把旧内容备份到 follows.json.bak，损坏可回滚。
 * 3. 写入走「临时文件 + rename」原子替换，并串行化，避免并发互相覆盖。
 */
const fs = require('fs');
const path = require('path');
const { normalizeUniqueId } = require('./follow-record');

const FILE = path.join(__dirname, 'follows.json');
const BACKUP = `${FILE}.bak`;

/**
 * 读取关注列表。
 * - 文件不存在：返回 []（首次使用的正常状态）
 * - 文件存在但无法解析 / 不是数组：抛错（绝不静默返回 []，避免被当成"空列表"回写）
 */
function readFollows() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`读取关注列表失败：${e.message}`);
  }

  const text = raw.trim();
  if (!text) return [];

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `关注列表文件已损坏（${FILE}）：${e.message}。` +
        `为避免覆盖数据已中止操作，请检查该文件，或从 ${path.basename(BACKUP)} 恢复。`
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(`关注列表文件格式异常（${FILE}）：顶层应为数组。`);
  }
  return data;
}

/** 串行化写入，避免并发请求互相覆盖 */
let writeChain = Promise.resolve();

function writeFollowsSync(list) {
  if (!Array.isArray(list)) {
    throw new Error('writeFollows 只接受数组');
  }
  // 覆盖前备份旧内容（旧文件存在且非空时才备份）
  try {
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > 2) {
      fs.copyFileSync(FILE, BACKUP);
    }
  } catch (e) {
    // 备份失败不阻断主流程，但记录下来
    console.warn('[follows-store] 备份失败:', e.message);
  }

  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function writeFollows(list) {
  writeChain = writeChain.then(
    () => writeFollowsSync(list),
    () => writeFollowsSync(list) // 前一次失败不应阻断后续写入
  );
  return writeChain;
}

module.exports = { FILE, BACKUP, normalizeUniqueId, readFollows, writeFollows };
