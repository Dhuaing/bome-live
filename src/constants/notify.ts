/**
 * 订阅消息（开播提醒）配置。
 *
 * 模板 ID 从「订阅消息 → 公共模板库」选模板后获得，
 * 指引见 docs/小程序注册与云开发迁移指引.md 第 7 步。
 *
 * 取值来源：
 * - 默认留空（表示模板尚未配置，前端隐藏「开启提醒」入口，不假装可用）
 * - 可用环境变量 SUBS_TEMPLATE_ID 经 defineConstants 编译期注入，
 *   与 CLOUD_ENV_ID 同一套机制（config/index.ts）
 *
 * 注意：不能直接写 `process.env.SUBS_TEMPLATE_ID`。
 * 未在 defineConstants 声明的键会原样保留到产物，
 * 浏览器端会因 `process is not defined` 白屏（踩过：见 README 环境配置）。
 */

/** 开播通知的订阅模板 ID */
export const SUBS_TEMPLATE_ID: string = process.env.TARO_APP_SUBS_TEMPLATE_ID || '';
