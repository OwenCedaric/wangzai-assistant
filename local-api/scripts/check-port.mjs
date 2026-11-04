import { connect } from 'node:net';
import { loadConfig } from '../src/config/loadConfig.js';

const config = loadConfig();
const { host, port } = config.server;
const baseUrl = `http://${host}:${port}`;

function canConnect() {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function readHealthIfAny() {
  try {
    const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_error) {
    return null;
  }
}

if (!(await canConnect())) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: 'free',
        host,
        port,
        message: 'local-api 端口未占用，可以启动。',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const health = await readHealthIfAny();

console.error(
  JSON.stringify(
    {
      ok: false,
      status: 'occupied',
      host,
      port,
      message: health?.service === 'wangzai-local-api' ? 'local-api 已经在运行，请不要重复启动。' : '端口已被其他进程占用。',
      health: health || null,
      next: health?.service === 'wangzai-local-api' ? `直接使用 ${baseUrl}` : '结束占用进程，或通过 LOCAL_API_PORT 指定其他端口。',
    },
    null,
    2,
  ),
);

process.exit(1);
