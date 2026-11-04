import { createConnection } from 'node:net';

const DEFAULT_LOOPBACK_HTTP_PROXY_PORTS = Object.freeze([7890, 7891, 7892, 10809]);
const DEFAULT_CONNECT_TARGET = 'seller.ozon.ru:443';

function boundedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
}

function probeLoopbackHttpProxy(port, {
  timeoutMs = 500,
  connectTarget = DEFAULT_CONNECT_TARGET,
  createConnectionImpl = createConnection,
} = {}) {
  return new Promise((resolve) => {
    const normalizedPort = boundedPort(port);
    if (!normalizedPort) {
      resolve(null);
      return;
    }

    let settled = false;
    let response = '';
    let socket;
    const finish = (value = null) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch {}
      resolve(value);
    };

    try {
      socket = createConnectionImpl({ host: '127.0.0.1', port: normalizedPort });
      socket.setTimeout(Math.max(100, Math.min(Number(timeoutMs) || 500, 2_000)));
      socket.once('connect', () => {
        socket.write(
          `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\nProxy-Connection: keep-alive\r\n\r\n`,
        );
      });
      socket.on('data', (chunk) => {
        response += chunk.toString('latin1');
        if (!response.includes('\r\n\r\n') && response.length < 4_096) return;
        const accepted = /^HTTP\/1\.[01]\s+2\d\d(?:\s|\r?$)/imu.test(response.split('\r\n', 1)[0]);
        finish(accepted ? normalizedPort : null);
      });
      socket.once('timeout', () => finish(null));
      socket.once('error', () => finish(null));
      socket.once('end', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

export async function detectFollowSellerLoopbackHttpProxy({
  ports = DEFAULT_LOOPBACK_HTTP_PROXY_PORTS,
  timeoutMs = 500,
  connectTarget = DEFAULT_CONNECT_TARGET,
  createConnectionImpl = createConnection,
} = {}) {
  const candidates = [...new Set((Array.isArray(ports) ? ports : [])
    .map(boundedPort)
    .filter(Boolean))];
  const results = await Promise.all(candidates.map((port) => probeLoopbackHttpProxy(port, {
    timeoutMs,
    connectTarget,
    createConnectionImpl,
  })));
  const port = results.find(Boolean);
  if (!port) return null;
  return Object.freeze({
    mode: 'fixed_servers',
    rules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
    bypassRules: '<-loopback>',
    credentialRef: '',
    source: 'verified-loopback-http-proxy',
  });
}
