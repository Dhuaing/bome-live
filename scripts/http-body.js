/**
 * HTTP 请求体读取（带大小上限）。
 *
 * 原实现无上限地把 chunk 推进数组，局域网内任何人循环发大 body
 * 都能把 Node 进程打爆（默认堆约 1.5GB）。这里在累积阶段就截断。
 */
const { MAX_BODY_BYTES } = require('./security');

/** 请求体超限时抛出的错误标记，便于上层区分 */
class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`请求体过大（上限 ${limit} 字节）`);
    this.name = 'BodyTooLargeError';
    this.code = 'BODY_TOO_LARGE';
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 超限处理要点：立刻 reject 让上层回 413，但**继续把剩余数据读完丢弃**。
 * - 不 destroy：否则客户端收到 ECONNRESET，拿不到 413
 * - 不 pause：否则请求永远不结束，连接挂住
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>} 解析后的对象；空 body 或非法 JSON 返回 {}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return; // 已超限：只丢弃，不再累积
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0; // 释放已缓冲的内存
        if (!settled) {
          settled = true;
          reject(new BodyTooLargeError(MAX_BODY_BYTES));
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        // 非法 JSON 视为空参数，由业务层报"参数不完整"
        resolve({});
      }
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

module.exports = { readJsonBody, BodyTooLargeError };
