/**
 * 云函数入参解析（单一实现）。
 *
 * 云函数有两个调用入口：
 * 1. 小程序 Taro.cloud.callFunction —— 参数直接平铺在 event 上
 * 2. HTTP 网关 —— 参数在 event.body（JSON 字符串）或 queryStringParameters 里
 *
 * 原先 getStreamerStatus 和 toggleFollow 各写了一份几乎相同的 parseParams，
 * 这里统一，避免两处规则漂移。
 */

/**
 * 把各种入口的 event 归一成普通参数对象。
 * @param {object} event 云函数入参
 * @param {string[]} directKeys 出现即说明是直接调用（参数已在顶层）的字段名
 */
function parseParams(event, directKeys = []) {
  if (!event || typeof event !== 'object') return {};

  const hasDirect = directKeys.some((k) => event[k] !== undefined && event[k] !== null);
  if (hasDirect) return event;

  const merged = Object.assign({}, event.queryStringParameters, event.pathParameters);
  if (!event.body) return merged;

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (body && typeof body === 'object') Object.assign(merged, body);
  } catch (e) {
    // body 非 JSON，忽略（保持 merged 原样）
  }
  return merged;
}

module.exports = { parseParams };
