import path from 'node:path';
import { createSignedUiUpdateStore } from './signedUiUpdateStore.js';
import { downloadUiUpdate } from './uiUpdateDownload.js';
import { licenseAuthorizationScope } from '../licensing/licenseAuthorizationScope.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const safeCode = error => /^[A-Z0-9_]{1,100}$/u.test(error?.code || error?.message || '') ? error.code || error.message : 'UI_UPDATE_FAILED';

// One instance per locked profile/main process. Never switches live renderer
// code, restarts services or changes any business database/schema.
export function createUiUpdateRuntime({ config, dataRoot, bundledDirectory, getSession, getToken,
  healthDelayMs = 1500, fetchImpl, logger = () => {} } = {}) {
  const enabled = config?.enabled === true;
  const store = enabled ? createSignedUiUpdateStore({ ...config, directory: path.join(dataRoot, 'signed-ui-updates') }) : null;
  let boot = null, lastError = '', checking = null, healthTimer = null, failed = false, disposed = false;
  const timers = new Set();
  const boundWindows = new WeakSet();
  function status() {
    if (!enabled) return { enabled: false };
    let current;
    try { current = store.status(); } catch (error) { lastError = safeCode(error); }
    return { enabled: true, active: boot?.id || null, pending: current?.pending || null,
      checking: Boolean(checking), trial: boot?.trial === true, lastError };
  }
  function prepareBoot({ recoveryMode = false } = {}) {
    if (boot) throw new Error('UI_UPDATE_BOOT_ALREADY_PREPARED');
    if (!enabled || recoveryMode) { boot = { id: null, directory: bundledDirectory, trial: false }; return boot; }
    try {
      const next = store.prepareBoot();
      boot = { ...next, directory: next.directory || bundledDirectory };
      if (next.rejectedPending) lastError = next.rejectedPending;
    } catch (error) {
      lastError = safeCode(error);
      boot = { id: null, directory: bundledDirectory, trial: false };
    }
    logger({ kind: 'ui-update-boot', id: boot.id, rolledBack: boot.rolledBack === true, error: lastError });
    return boot;
  }
  async function checkOnce() {
    if (!enabled || disposed) return { ok: false, enabled, code: 'UI_UPDATE_DISABLED' };
    const before = await getSession();
    if (before?.authorized !== true) return { ok: false, code: 'UI_UPDATE_LOGIN_REQUIRED' };
    const scope = licenseAuthorizationScope(before.user, config.appId);
    if (!scope) return { ok: false, code: 'UI_UPDATE_LOGIN_REQUIRED' };
    let token = await getToken();
    let result;
    try { result = await downloadUiUpdate({ baseUrl: config.baseUrl, token, trust: config, fetchImpl }); }
    catch (error) {
      if (error?.status !== 401) throw error;
      token = await getToken({ forceRefresh: true, rejectedAccessToken: token });
      result = await downloadUiUpdate({ baseUrl: config.baseUrl, token, trust: config, fetchImpl });
    }
    const after = await getSession();
    if (disposed || after?.authorized !== true || licenseAuthorizationScope(after.user, config.appId) !== scope) throw new Error('UI_UPDATE_AUTH_SCOPE_CHANGED');
    if (!result.available) return { ok: true, state: 'current' };
    const current = store.status();
    if ([current.active, current.pending].includes(result.id)) return { ok: true, state: current.pending === result.id ? 'staged' : 'current', id: result.id };
    if (current.failed.includes(result.id)) return { ok: false, code: 'UI_UPDATE_PREVIOUSLY_FAILED' };
    const staged = store.stage(result.bundle);
    return { ok: true, state: 'staged', id: staged.id, sequence: staged.sequence };
  }
  function check() {
    if (checking) return checking;
    checking = checkOnce().catch(error => {
      lastError = safeCode(error); logger({ kind: 'ui-update-check-failed', error: lastError });
      return { ok: false, code: lastError };
    }).finally(() => { checking = null; });
    return checking;
  }
  function reportHealth(healthy) {
    if (!enabled || !boot?.trial || disposed) return { accepted: false };
    if (!healthy) { failed = true; if (healthTimer) clearTimeout(healthTimer); healthTimer = null; return { accepted: true, failed: true }; }
    if (failed) return { accepted: false, code: 'UI_UPDATE_STARTUP_FAILED' };
    if (!healthTimer) {
      healthTimer = setTimeout(() => {
        timers.delete(healthTimer); healthTimer = null;
        if (failed || disposed) return;
        try { store.markHealthy(boot.id); boot = { ...boot, trial: false }; }
        catch (error) { failed = true; lastError = safeCode(error); }
      }, healthDelayMs);
      timers.add(healthTimer);
    }
    return { accepted: true };
  }
  function bindWindow(window) {
    if (!enabled || boundWindows.has(window)) return;
    boundWindows.add(window);
    window.webContents.on('render-process-gone', () => reportHealth(false));
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (code !== -3 && isMainFrame !== false) reportHealth(false);
    });
    window.on('closed', () => reportHealth(false));
  }
  function readStatic(requestUrl) {
    if (!boot?.id) return null;
    let relative;
    try { relative = decodeURIComponent(requestUrl.pathname).replace(/^\//u, ''); } catch { return new Response('Bad path', { status: 400 }); }
    if (!relative || !path.extname(relative)) relative = 'index.html';
    try {
      return new Response(store.readAsset(boot.id, relative), { status: 200, headers: {
        'content-type': MIME[path.extname(relative)] || 'application/octet-stream',
        // A signed resource need not have a content-hashed filename; avoid a
        // previous boot's browser cache returning an older same-name script.
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    } catch (error) {
      if (error?.code !== 'UI_UPDATE_ASSET_NOT_LISTED') reportHealth(false);
      return new Response('Verified update asset unavailable', { status: error?.code === 'UI_UPDATE_ASSET_NOT_LISTED' ? 404 : 500 });
    }
  }
  function dispose() { disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); }
  return { prepareBoot, currentDirectory: () => boot?.directory || bundledDirectory, status, check, reportHealth, bindWindow, readStatic, dispose };
}

export function registerUiUpdateIpc({ ipcMain, getWindow, runtime, appHost = 'wangzai' }) {
  const name = 'desktop:ui-updates';
  ipcMain.removeHandler(name);
  ipcMain.handle(name, async (event, input = {}) => {
    const window = getWindow(), frame = event?.senderFrame;
    let origin;
    try { origin = new URL(frame?.url || ''); } catch { return { ok: false, code: 'UI_UPDATE_SENDER_REJECTED' }; }
    if (!window || event.sender !== window.webContents || frame !== event.sender.mainFrame
      || origin.protocol !== 'app:' || origin.hostname !== appHost) return { ok: false, code: 'UI_UPDATE_SENDER_REJECTED' };
    if (input?.action === 'status') return runtime.status();
    if (input?.action === 'check') return runtime.check();
    if (input?.action === 'ready') return runtime.reportHealth(true);
    if (input?.action === 'failed') return runtime.reportHealth(false);
    return { ok: false, code: 'UI_UPDATE_ACTION_INVALID' };
  });
}
