/**
 * 云开发环境配置。
 *
 * 原先环境 ID 散落在 5 个地方（app.tsx / serve-h5.js / watch-live.js /
 * watch-live.config.json / cloudbaserc.json），换环境要改 5 处，漏一处就是线上事故。
 *
 * 现在集中在这里，取值来源：
 * - 前端：config/index.ts 的 defineConstants 在编译期注入 TARO_APP_CLOUD_ENV_ID
 * - Node 脚本：环境变量 TCB_ENV_ID（见 scripts/cloud-env.js）
 *
 * 注意：不能直接写 `process.env.TCB_ENV_ID`。
 * Taro/webpack 只会替换 defineConstants 里显式声明的键，其余 `process.env.X`
 * 会原样保留到产物里，浏览器执行时因 `process` 不存在而白屏。
 */

/** 云开发环境 ID（编译期由 defineConstants 注入） */
export const CLOUD_ENV_ID: string =
  process.env.TARO_APP_CLOUD_ENV_ID || 'bome-app-d6gb6gk0j89b15e5e';

/** 云函数 HTTP 网关域名（H5 端经 serve-h5.js 代理到这里） */
export const CLOUD_GATEWAY_HOST: string =
  process.env.TARO_APP_CLOUD_GATEWAY_HOST ||
  `${CLOUD_ENV_ID}-1488077222.ap-shanghai.app.tcloudbase.com`;
