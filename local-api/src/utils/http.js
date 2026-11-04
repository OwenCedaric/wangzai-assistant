import { parseJsonText } from './jsonText.js';

export function createJsonResponse(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function createTextResponse(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function readJsonRequestBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0;
    let chunks = [];
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        chunks = [];
        const error = new Error(`请求体超过 local-api 单次传输限制：${maxBytes} bytes`);
        error.code = 'REQUEST_BODY_TOO_LARGE';
        error.maxBytes = maxBytes;
        error.receivedBytes = receivedBytes;
        // Keep draining the socket instead of destroying it. Destroying here
        // turns a controlled 413 into Electron's misleading "fetch failed".
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        resolve(parseJsonText(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        const error = new Error('请求体不是有效 JSON。');
        error.code = 'BAD_JSON_BODY';
        reject(error);
      }
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function getRequestOrigin(req) {
  return req.headers.origin || '';
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

export function isAllowedCorsOrigin(origin, config) {
  if (!origin) {
    return false;
  }

  const security = config.security || {};
  const allowedOrigins = new Set(security.allowOrigins || []);

  if (allowedOrigins.has(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const port = Number.parseInt(parsed.port, 10);
    const allowLoopbackVitePorts = security.allowLoopbackVitePorts || [];

    return (
      parsed.protocol === 'http:' &&
      isLoopbackHostname(parsed.hostname) &&
      Number.isFinite(port) &&
      allowLoopbackVitePorts.includes(port)
    );
  } catch (_error) {
    return false;
  }
}

export function createCorsHeaders(config, req) {
  const origin = getRequestOrigin(req);
  const headers = {
    vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type, accept, x-wangzai-local-api',
    'access-control-max-age': '600',
  };

  if (origin && isAllowedCorsOrigin(origin, config)) {
    headers['access-control-allow-origin'] = origin;
  } else if (!origin) {
    headers['access-control-allow-origin'] = 'http://127.0.0.1:5173';
  }

  return headers;
}
