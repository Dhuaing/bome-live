/**
 * 云开发环境配置。
 *
 * 原先环境 ID 散落在 5 个地方（app.tsx / watch-live.js /
 * watch-live.config.json / cloudbaserc.json 等），换环境要改多处，漏一处就是线上事故。
 *
 * 现在集中在这里，取值来源：
 * - 前端：config/index.ts 的 defineConstants 在编译期注入 TARO_APP_CLOUD_ENV_ID
 * - Node 脚本：环境变量 TCB_ENV_ID（见 scripts/cloud-env.js）
 *
 * 注意：不能直接写 `process.env.TCB_ENV_ID`。
 * Taro/webpack 只会替换 defineConstants 里显式声明的键，其余 `process.env.X`
 * 会原样保留到产物里，运行时因 `process` 不存在而白屏。
 */

/** 云开发环境 ID（编译期由 defineConstants 注入；默认值=线上真实环境，防忘传 env 时连旧环境——坑 #5 根治） */
export const CLOUD_ENV_ID: string =
  process.env.TARO_APP_CLOUD_ENV_ID || 'bome-livedongyailongwang-d91c6e8';

/** 云函数 HTTP 网关域名（Node 侧脚本直连用；小程序端不经此，走 Taro.cloud） */
export const CLOUD_GATEWAY_HOST: string =
  process.env.TARO_APP_CLOUD_GATEWAY_HOST ||
  `${CLOUD_ENV_ID}-1488077222.ap-shanghai.app.tcloudbase.com`;
