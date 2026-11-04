import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileMetadata } from '../src/runtime/profileMetadata.js';
import { resolveDataLayout } from '../src/runtime/dataLayout.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDirectory, '..');
const electronExecutable = path.join(
  desktopRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const runtimeRoot = path.join(desktopRoot, '.desktop-recovery-shell-smoke', String(Date.now()));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function runElectron({ localApiPort, bridgePort }) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronExecutable, ['.', '--smoke-test'], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        WANGZAI_DESKTOP_DATA_DIR: runtimeRoot,
        LOCAL_API_PORT: String(localApiPort),
        PURCHASE_SEARCH_BRIDGE_PORT: String(bridgePort),
        LOCAL_API_DB_PATH: '',
        LOCAL_API_SECRET_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(reject, new Error(`恢复 shell 烟测超时。stdout=${stdout.slice(-1200)} stderr=${stderr.slice(-1200)}`));
    }, 40_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => settle(reject, error));
    child.once('exit', (code, signal) => settle(resolve, { code, signal, stdout, stderr }));
  });
}

try {
  const layout = resolveDataLayout({ dataRoot: runtimeRoot });
  const profile = {
    ...createProfileMetadata({
      dataRoot: layout.dataRoot,
      createdAt: new Date('2026-07-12T00:00:00.000Z'),
      profileId: 'recovery-shell-smoke-profile',
    }),
    databaseInitializedAt: '2026-07-12T00:01:00.000Z',
  };
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(layout.profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  const [localApiPort, bridgePort] = await Promise.all([findFreePort(), findFreePort()]);
  const result = await runElectron({ localApiPort, bridgePort });
  const [mainLog, rendererLog, persistedProfile] = await Promise.all([
    fs.readFile(path.join(layout.logDirectory, 'desktop-main.log'), 'utf8').catch(() => ''),
    fs.readFile(path.join(layout.logDirectory, 'desktop-renderer.log'), 'utf8').catch(() => ''),
    fs.readFile(layout.profilePath, 'utf8').then(JSON.parse),
  ]);
  const shellExists = await fs.access(path.join(layout.localApiDataRoot, 'recovery-shell.sqlite'))
    .then(() => true)
    .catch(() => false);
  const activeExists = await fs.access(layout.databasePath).then(() => true).catch(() => false);
  if (
    result.code !== 0 ||
    !mainLog.includes('[smoke] renderer-ready') ||
    !mainLog.includes('"mode":"recovery"') ||
    !persistedProfile.databaseRecoveryRequiredAt ||
    !shellExists ||
    activeExists
  ) {
    throw new Error(
      `恢复 shell 烟测失败：exit=${result.code} signal=${result.signal || ''} shell=${shellExists} active=${activeExists}\nmain:\n${mainLog.slice(-4000)}\nrenderer:\n${rendererLog.slice(-4000)}\nstderr:\n${result.stderr.slice(-2000)}`,
    );
  }
  console.log(JSON.stringify({ ok: true, recoveryShell: true, activeDatabaseCreated: false }, null, 2));
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
}
