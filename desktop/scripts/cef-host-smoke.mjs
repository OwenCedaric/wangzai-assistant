import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = process.env.WANGZAI_CEF_HOST_ROOT
  ? path.resolve(process.env.WANGZAI_CEF_HOST_ROOT)
  : path.join(
      desktopRoot,
      'native',
      'Wangzai.CefBrowserHost',
      'publish',
    );
const executable = path.join(runtimeRoot, 'Wangzai.CefBrowserHost.exe');
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('PURCHASE_BROWSER_CEF_HOST_MISSING');
}
const smokeRoot = path.join(
  desktopRoot,
  '.tmp',
  `cef-host-smoke-${process.pid}-${randomUUID()}`,
);
fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(smokeRoot, { recursive: true });
const extensionsRoot = path.join(smokeRoot, 'extensions');
const builtInOzonObserver = path.join(
  desktopRoot,
  'resources',
  'browser-extensions',
  'ozon-analytics-observer',
);
const builtInOzonObserverVersion = JSON.parse(
  fs.readFileSync(path.join(builtInOzonObserver, 'manifest.json'), 'utf8'),
).version;
const extensionSmokeTitle = 'WANGZAI_EXTENSION_SMOKE_OK';
const captureVersion = '1.4.0';
prepareSmokeExtension();
const ownerRef = '0123456789abcdef0123456789abcdef01234567';
let buffer = '';
let launched = false;
let finished = false;
let socket = null;
let child = null;
let inspectAttempts = 0;
const pipeName = 'wangzai-cef-smoke-' + randomUUID();
const pipePath = '\\\\.\\pipe\\' + pipeName;
const server = net.createServer((connection) => {
  socket = connection;
  connection.setEncoding('utf8');
  connection.on('data', consume);
});
server.listen(pipePath, () => {
  child = spawn(executable, [
    '--wangzai-ipc-pipe=' + pipeName,
    '--wangzai-root-cache=' + smokeRoot,
    '--wangzai-extensions-root=' + extensionsRoot,
    '--wangzai-built-in-extension=' + builtInOzonObserver,
  ], {
    cwd: runtimeRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('error', (error) => finish(error));
  child.once('exit', (code) => {
    clearTimeout(timeout);
    if (!finished && code !== 0) finish(new Error('PURCHASE_BROWSER_CEF_SMOKE_EXIT_' + code));
  });
});
const timeout = setTimeout(() => finish(new Error('PURCHASE_BROWSER_CEF_SMOKE_TIMEOUT')), 45_000);

function write(command, payload = {}, id = 'cef_smoke_' + Date.now()) {
  socket?.write(JSON.stringify({ id, command, payload }) + '\n', 'utf8');
}

function prepareSmokeExtension() {
  fs.rmSync(extensionsRoot, { recursive: true, force: true });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyBytes = publicKey.export({ type: 'spki', format: 'der' });
  const key = keyBytes.toString('base64');
  const digest = createHash('sha256').update(keyBytes).digest();
  let extensionId = '';
  for (const value of digest.subarray(0, 16)) {
    extensionId += String.fromCharCode(97 + (value >> 4));
    extensionId += String.fromCharCode(97 + (value & 15));
  }
  const packageRoot = path.join(extensionsRoot, 'packages', extensionId);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '旺崽插件加载验证',
    version: '1.0.0',
    key,
    content_scripts: [{
      matches: ['https://example.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    }],
  }, null, 2));
  fs.writeFileSync(
    path.join(packageRoot, 'content.js'),
    `document.title=${JSON.stringify(extensionSmokeTitle)};`,
  );
  fs.writeFileSync(path.join(extensionsRoot, 'registry.json'), JSON.stringify({
    version: 1,
    plugins: [{
      id: extensionId,
      enabled: true,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2));
}

function finish(error = null) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (child?.exitCode === null) {
    try { write('shutdown', {}, 'shutdown1'); } catch { child.kill(); }
  }
  setTimeout(() => {
    server.close();
    socket?.destroy();
    if (child?.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      }
      child.kill();
    }
  }, 1500);
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function consume(chunk) {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === 'ready' && !launched) {
      launched = true;
      write('launch', {
        profile: {
          ownerRef,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
          acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.6',
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
          platformKey: '1688',
          fingerprint: { seed: 'smoke-seed' },
          proxy: { mode: 'direct' },
        },
        profileDirectory: path.join(smokeRoot, 'profile'),
        downloadsDirectory: path.join(smokeRoot, 'downloads'),
        url: 'https://example.com/',
        parentHwnd: '0',
        initialBounds: {
          x: 180,
          y: 120,
          width: 1100,
          height: 700,
          visible: !process.argv.includes('--headless'),
        },
      }, 'launch1');
    } else if (message.type === 'response' && message.id === 'launch1') {
      if (!message.ok) {
        finish(new Error(message.error?.code || 'PURCHASE_BROWSER_CEF_SMOKE_LAUNCH_FAILED'));
      } else {
        setTimeout(() => write('state', { ownerRef }, 'state1'), 1200);
      }
    } else if (message.type === 'response' && message.id === 'state1') {
      if (!message.ok || message.data?.engine !== 'cef') {
        finish(new Error(message.error?.code || 'PURCHASE_BROWSER_CEF_SMOKE_STATE_FAILED'));
      } else {
        inspectAttempts += 1;
        write('inspect', { ownerRef }, 'inspect1');
      }
    } else if (message.type === 'response' && message.id === 'inspect1') {
      const inspectionIncomplete = !message.ok
        ? message.error?.code === 'PURCHASE_BROWSER_CAPTURE_CONTEXT_NOT_READY'
        : message.data?.pageTitle !== extensionSmokeTitle
          || !message.data?.pageUrl
          || message.data?.extensionVersion !== captureVersion;
      if (inspectionIncomplete && inspectAttempts < 12) {
        inspectAttempts += 1;
        setTimeout(() => write('inspect', { ownerRef }, 'inspect1'), 500);
        return;
      }
      if (
        !message.ok
        || message.data?.pageTitle !== extensionSmokeTitle
        || !message.data?.pageUrl
        || message.data?.extensionVersion !== captureVersion
      ) {
        finish(new Error(message.error?.code || 'PURCHASE_BROWSER_CEF_SMOKE_INSPECT_FAILED'));
      } else {
        write('ozon-data-status', { ownerRef }, 'ozonObserver1');
      }
    } else if (message.type === 'response' && message.id === 'ozonObserver1') {
      if (
        !message.ok
        || message.data?.installed !== true
        || message.data?.enabled !== true
        || message.data?.extensionVersion !== builtInOzonObserverVersion
      ) {
        finish(new Error(message.error?.code || 'OZON_DATA_OBSERVER_SMOKE_FAILED'));
      } else {
        const expires = Math.floor(Date.now() / 1000) + 3600;
        write('import-purchase-session-cookies', {
          ownerRef,
          cookies: [
            { name: 'unb', value: 'smoke-user-1688', domain: '.1688.com', path: '/', secure: true, httpOnly: true, expirationDate: expires },
            { name: 'cookie2', value: 'smoke-session-1688', domain: '.1688.com', path: '/', secure: true, httpOnly: true, expirationDate: expires },
          ],
        }, 'paymentCookieImport1');
      }
    } else if (message.type === 'response' && message.id === 'paymentCookieImport1') {
      if (
        !message.ok
        || message.data?.importedCookieCount !== 2
        || message.data?.cookieSaved !== true
      ) {
        finish(new Error(message.error?.code || 'PURCHASE_PAYMENT_COOKIE_IMPORT_SMOKE_FAILED'));
      } else {
        write('purchase-login-status', { ownerRef }, 'paymentLoginStatus1');
      }
    } else if (message.type === 'response' && message.id === 'paymentLoginStatus1') {
      if (
        !message.ok
        || message.data?.loggedIn !== true
        || message.data?.cookieSaved !== true
        || message.data?.platformKey !== '1688'
      ) {
        finish(new Error(message.error?.code || 'PURCHASE_PAYMENT_LOGIN_STATUS_SMOKE_FAILED'));
      } else {
        console.log(JSON.stringify({
          ok: true,
          engine: 'cef',
          captureVersion,
          pageTitle: extensionSmokeTitle,
          ozonObserverVersion: builtInOzonObserverVersion,
          paymentLoginVerified: true,
        }));
        finish();
      }
    }
  }
}
