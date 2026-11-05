/**
 * Node 脚本侧的云开发环境配置（与 src/constants/cloud.ts 保持同一来源）。
 *
 * 优先级：环境变量 > 这里的默认值。
 * 换环境时只需设置 TCB_ENV_ID，不用改代码。
 */
const CLOUD_ENV_ID = process.env.TCB_ENV_ID || 'bome-app-d6gb6gk0j89b15e5e';

/** 云函数 HTTP 网关域名 */
const CLOUD_GATEWAY_HOST =
  process.env.TCB_GATEWAY_HOST ||
  `${CLOUD_ENV_ID}-1488077222.ap-shanghai.app.tcloudbase.com`;

module.exports = { CLOUD_ENV_ID, CLOUD_GATEWAY_HOST };
