import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { LocalCacheAgentKeyStore } from './localCacheAgentKeyStore.js';

const DEFAULT_PORT = 3792;

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function resolveLoopbackPort(preferredPort) {
  for (let offset = 0; offset < 40; offset += 1) {
    const port = preferredPort + offset;
    if (port <= 65_535 && await portAvailable(port)) return port;
  }
  throw new Error('LOCAL_CACHE_AGENT_PORT_UNAVAILABLE');
}

async function waitForHealth({ baseUrl, child, fetchImpl, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`LOCAL_CACHE_AGENT_EXITED:${child.exitCode}`);
    }
    try {
      const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      const payload = await response.json();
      if (response.ok && payload?.service === 'wangzai-local-cache-agent') return;
    } catch {
      // Child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('LOCAL_CACHE_AGENT_START_TIMEOUT');
}

export function createLocalCacheAgentRuntime({
  supervisor,
  safeStorage,
  dataRoot,
  scriptPath,
  preferredPort = DEFAULT_PORT,
  fetchImpl = fetch,
  resolvePort = resolveLoopbackPort,
  startTimeoutMs = 30_000,
} = {}) {
  if (!supervisor?.spawnElectronNodeScript) throw new Error('LOCAL_CACHE_AGENT_SUPERVISOR_REQUIRED');
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedScriptPath = path.resolve(scriptPath);
  const keyStore = new LocalCacheAgentKeyStore({
    directory: path.join(resolvedDataRoot, 'runtime'),
    safeStorage,
  });
  let runtime = null;

  async function start() {
    if (runtime) return runtime;
    const [port, encryptionKey] = await Promise.all([
      resolvePort(Number(preferredPort) || DEFAULT_PORT),
      keyStore.loadOrCreateKey(),
    ]);
    const authToken = crypto.randomBytes(32).toString('base64url');
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = supervisor.spawnElectronNodeScript('local-cache-agent-v2', resolvedScriptPath, {
      cwd: path.dirname(resolvedScriptPath),
      env: {
        WANGZAI_CACHE_AGENT_PORT: String(port),
        WANGZAI_CACHE_AGENT_TOKEN: authToken,
        WANGZAI_CACHE_AGENT_ENCRYPTION_KEY: encryptionKey,
        WANGZAI_CACHE_AGENT_DATA_ROOT: resolvedDataRoot,
      },
    });
    await waitForHealth({ baseUrl, child, fetchImpl, timeoutMs: startTimeoutMs });
    runtime = Object.freeze({
      service: 'wangzai-local-cache-agent',
      baseUrl,
      port,
      authToken,
      dataRoot: resolvedDataRoot,
      databasePath: path.join(resolvedDataRoot, 'wangzai-user-cache.sqlite'),
      remote: false,
    });
    return runtime;
  }

  return Object.freeze({ start, getRuntime: () => runtime });
}

