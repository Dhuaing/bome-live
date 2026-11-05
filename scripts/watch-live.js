/**
 * 开播巡检脚本
 *
 * 每 intervalMs 检查一次关注列表里每个抖音主播的直播状态（数据来自 scripts/follows.json，
 * 与网页共用同一份），当状态从"未开播"翻转为"直播中"时，通过本机 nanobot 推送消息到微信。
 * 同一场直播只推一次。
 *
 * 用法：
 *   node scripts/watch-live.js                常驻运行（Ctrl+C 退出）
 *   node scripts/watch-live.js --once         跑一轮就退出（调试用）
 *   node scripts/watch-live.js --test-notify  直接发一条测试消息，验证微信链路
 *   node scripts/watch-live.js --reset        清空本地状态（下次运行会静默重新 seed）
 *
 * 注意：脚本只在本机运行时才有效，电脑关机期间不会巡检、也收不到提醒。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { readFollows, FILE: FOLLOWS_FILE } = require('./follows-store');
const { CLOUD_GATEWAY_HOST } = require('./cloud-env');
const { resolveRoomUrl } = require('./follow-record');
const { evaluate, formatMessage } = require('../cloudfunctions/_shared/watch-rules');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'watch-live.config.json');
const STATE_FILE = path.join(__dirname, '.watch-state.json');

const DEFAULT_CONFIG = {
  triggerId: '',
  nanobotExe: 'python',
  nanobotArgs: ['-m', 'nanobot'],
  nanobotCwd: '',
  gatewayHost: CLOUD_GATEWAY_HOST,
  intervalMs: 60000
};

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);

function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // 配置文件不存在或格式错误，使用默认值
  }
  const config = { ...DEFAULT_CONFIG, ...fileConfig };
  if (process.env.WATCH_TRIGGER_ID) config.triggerId = process.env.WATCH_TRIGGER_ID;
  if (process.env.TCB_GATEWAY_HOST) config.gatewayHost = process.env.TCB_GATEWAY_HOST;
  return config;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function postJson(host, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        host,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`响应不是 JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.write(payload);
    req.end();
  });
}

/** 执行 nanobot 推送命令，返回是否被接受（不代表微信已收到） */
function runNanobot(config, message) {
  return new Promise((resolve) => {
    const argv = [].concat(config.nanobotArgs || [], ['trigger', config.triggerId, message]);
    const child = spawn(config.nanobotExe || 'python', argv, {
      cwd: config.nanobotCwd || ROOT,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => {
      console.error('[watch] 推送命令启动失败:', e.message);
      resolve(false);
    });
    child.on('close', (code) => resolve(onNanobotClose({ code, stdout, stderr, message })));
  });
}

/** 处理推送命令退出：成功与否的日志都在这里 */
function onNanobotClose({ code, stdout, stderr, message }) {
  if (code !== 0) {
    const detail = (stderr || stdout).slice(0, 300);
    console.error(`[watch] 推送失败 (exit ${code}):`, detail);
    if (!detail) {
      console.error(
        '[watch] 无输出通常说明 nanobotExe 不是可用的 python（如 Windows 应用商店的占位程序），' +
          '请在 scripts/watch-live.config.json 里填 Python 的绝对路径。'
      );
    }
    return false;
  }
  // 注意：exit 0 只代表 nanobot 已接受并「入队」，不代表微信真的收到了。
  // 真正投递由 gateway 的 outbound dispatcher 异步完成，失败只会写进 nanobot 的日志
  // （C:\Users\<用户>\.nanobot\logs\gateway.log），这里看不到。
  console.log(`[watch] 已提交到 nanobot：${(stdout || '').trim() || message.replace(/\n/g, ' ')}`);
  return true;
}

function notify(config, message) {
  if (!config.triggerId) {
    console.error('[watch] 未配置 triggerId，跳过推送');
    return Promise.resolve(false);
  }
  return runNanobot(config, message);
}

/** 查询单个主播的状态；失败返回 null（调用方保留上次状态） */
async function queryStatus(config, uniqueId) {
  try {
    const res = await postJson(config.gatewayHost, '/getStreamerStatus', { uniqueId });
    if (!res || res.code !== 0 || !res.data) {
      console.warn(
        `[watch] ${uniqueId} 查询失败：${(res && res.message) || '无数据'}（保留上次状态）`
      );
      return null;
    }
    return res.data;
  } catch (e) {
    console.warn(`[watch] ${uniqueId} 请求失败：${e.message}（保留上次状态）`);
    return null;
  }
}

/** 处理单个主播：查询 → 判定 → 记录状态 → 必要时推送 */
async function processOne({ config, follow, state }) {
  const uniqueId = follow.uniqueId;
  if (!uniqueId) return false;

  const info = await queryStatus(config, uniqueId);
  if (!info) return false;

  const { next, notify: shouldPush, current } = evaluate(state[uniqueId], info);
  state[uniqueId] = next;

  if (shouldPush) {
    await notify(config, formatMessage(follow, info, resolveRoomUrl(follow.roomUrl, uniqueId)));
  }

  const time = new Date().toLocaleTimeString('zh-CN');
  console.log(`[watch] ${time} ${uniqueId} ${current}${shouldPush ? ' → 已推送' : ''}`);
  return shouldPush;
}

async function runRound(config) {
  const follows = readFollows();
  if (follows.length === 0) {
    console.log('[watch] 关注列表为空，跳过本轮');
    return;
  }

  const state = readState();
  let pushed = 0;

  for (const follow of follows) {
    if (await processOne({ config, follow, state })) pushed += 1;
  }

  writeState(state);
  console.log(`[watch] 本轮完成：巡检 ${follows.length} 个主播，推送 ${pushed} 条`);
}

(async () => {
  const config = loadConfig();

  if (hasFlag('--test-notify')) {
    const ok = await notify(config, '✅ 开播提醒测试消息：看到这条说明推送链路已通。');
    process.exit(ok ? 0 : 1);
  }

  if (hasFlag('--reset')) {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    console.log('[watch] 已清空状态文件，下次运行会重新 seed（不会补推历史开播）');
    process.exit(0);
  }

  if (!config.triggerId) {
    console.warn('[watch] ⚠️ 未配置 triggerId：巡检照常执行，但不会推送。');
    console.warn('[watch]    在微信里给 nanobot 发「/trigger 开播提醒」，把返回的 ID 填进 scripts/watch-live.config.json');
  }
  console.log(`[watch] 关注列表：${FOLLOWS_FILE}`);
  console.log(`[watch] 巡检频率：${config.intervalMs}ms`);

  if (hasFlag('--once')) {
    await runRound(config);
    return;
  }

  // 链式 setTimeout：一轮耗时超过间隔时不会像 setInterval 那样叠加
  let timer = null;
  const loop = async () => {
    try {
      await runRound(config);
    } catch (e) {
      console.error('[watch] 本轮异常:', e);
    }
    timer = setTimeout(loop, Math.max(10000, config.intervalMs || 60000));
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    console.log('\n[watch] 已停止');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await loop();
})();