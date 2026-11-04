const { contextBridge, ipcRenderer } = require('electron');

function getAdditionalArgument(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

const localApiBaseUrl = getAdditionalArgument('wangzai-local-api-base-url');
const purchaseBridgeBaseUrl = getAdditionalArgument('wangzai-purchase-bridge-base-url');
const legacyRetirementSeed = getAdditionalArgument('wangzai-legacy-retirement-seed');
const legacyRetirementSeedFile = getAdditionalArgument('wangzai-legacy-retirement-seed-file');
const legacyRetirementClearBrowserKeys = getAdditionalArgument('wangzai-legacy-retirement-clear-browser-keys');
const dashboardVisualTest = getAdditionalArgument('wangzai-dashboard-visual-test') === '1';

function loadLegacyRetirementSeed() {
  if (legacyRetirementSeed) return decodeURIComponent(legacyRetirementSeed);
  if (!legacyRetirementSeedFile) return '';
  try {
    return String(
      ipcRenderer.sendSync('desktop:legacy-retirement-read-seed', legacyRetirementSeedFile) || '',
    );
  } catch (_error) {
    return '';
  }
}

const legacyRetirementSeedPayload = loadLegacyRetirementSeed();
if (legacyRetirementSeedPayload) {
  try {
    const entries = JSON.parse(legacyRetirementSeedPayload);
    if (Array.isArray(entries)) {
      entries.forEach((entry) => {
        const key = String(entry?.key || '').trim();
        if (key) window.localStorage.setItem(key, entry?.raw === true ? String(entry.value ?? '') : JSON.stringify(entry.value));
      });
    }
  } catch (_error) {
    // The automation main process will fail its canonical/readback assertion instead of continuing with partial seed data.
  }
}

// A recovery-restart phase must prove the activated canonical database from a
// fresh local-data directory, not reconstruct it from the deliberately
// retained browser source copy. The main process supplies this argument only
// for the isolated --legacy-retirement-test phase; no values leave the fixture.
function clearLegacyRetirementBrowserKeys() {
  if (!legacyRetirementClearBrowserKeys) return [];
  try {
    const uniqueKeys = [...new Set(
      legacyRetirementClearBrowserKeys.split(',')
        .map((key) => String(key || '').trim())
        .filter(Boolean),
    )];
    uniqueKeys.forEach((key) => window.localStorage.removeItem(key));
    return uniqueKeys;
  } catch (_error) {
    return [];
  }
}

const legacyRetirementBrowserKeysCleared = clearLegacyRetirementBrowserKeys();

const purchaseBrowserEventListeners = new Set();
ipcRenderer.on('desktop:purchase-browser-event', (_event, payload) => {
  for (const callback of [...purchaseBrowserEventListeners]) {
    try { callback(payload); } catch { /* one page listener cannot break the shared broker */ }
  }
});

if (localApiBaseUrl) {
  contextBridge.exposeInMainWorld('__WANGZAI_LOCAL_API_BASE_URL__', localApiBaseUrl);
}

if (purchaseBridgeBaseUrl) {
  contextBridge.exposeInMainWorld('__WANGZAI_PURCHASE_BRIDGE_BASE_URL__', purchaseBridgeBaseUrl);
}

const wangzaiDesktop = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  localApiBaseUrl,
  purchaseBridgeBaseUrl,
  legacyRetirementBrowserClearCount: legacyRetirementBrowserKeysCleared.length,
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),
  uiUpdates: {
    status: () => ipcRenderer.invoke('desktop:ui-updates', { action: 'status' }),
    check: () => ipcRenderer.invoke('desktop:ui-updates', { action: 'check' }),
    ready: () => ipcRenderer.invoke('desktop:ui-updates', { action: 'ready' }),
    failed: () => ipcRenderer.invoke('desktop:ui-updates', { action: 'failed' }),
  },
  reloadWindow: () => ipcRenderer.invoke('desktop:reload-window'),
  setWindowMode: (mode) => ipcRenderer.invoke('desktop:set-window-mode', mode),
  requestProfileCacheMaintenance: () => ipcRenderer.invoke('desktop:profile-cache-maintenance'),
  localApiRequest: (input) => ipcRenderer.invoke('desktop:local-api-request', input),
  cancelLocalApiRequest: (requestId) => ipcRenderer.invoke('desktop:local-api-cancel', requestId),
  recoveryRequest: (input) => ipcRenderer.invoke('desktop:recovery-request', input),
  dataBackup: {
    command: (input) => ipcRenderer.invoke('desktop:data-backup-command', input),
  },
  wechatAssistant: {
    command: (input) => ipcRenderer.invoke('desktop:wechat-assistant-command', input),
  },
  ozonPushEndpoint: {
    command: (input) => ipcRenderer.invoke('desktop:ozon-push-endpoint-command', input),
  },
  purchaseBridgeRequest: (input) => ipcRenderer.invoke('desktop:purchase-bridge-request', input),
  purchaseBrowser: {
    command: (input) => ipcRenderer.invoke('desktop:purchase-browser-command', input),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      purchaseBrowserEventListeners.add(callback);
      return () => purchaseBrowserEventListeners.delete(callback);
    },
  },
  ...(dashboardVisualTest
    ? {
        captureDashboardVisual: (input) => ipcRenderer.invoke('desktop:dashboard-visual-capture', input),
      }
    : {}),
  license: {
    getRuntime: () => ipcRenderer.invoke('license:get-runtime'),
    getSession: () => ipcRenderer.invoke('license:get-session'),
    request: (input) => ipcRenderer.invoke('license:request', input),
    syncSmartReplyShop: (input) => ipcRenderer.invoke('license:sync-smart-reply-shop', input),
    beginLogin: () => ipcRenderer.invoke('license:begin-login'),
    getRememberedLogin: () => ipcRenderer.invoke('license:get-remembered-login'),
    saveRememberedLogin: (input) => ipcRenderer.invoke('license:save-remembered-login', input),
    clearRememberedLogin: () => ipcRenderer.invoke('license:clear-remembered-login'),
    loginWithRememberedCredentials: () => ipcRenderer.invoke('license:login-with-remembered-credentials'),
    logout: () => ipcRenderer.invoke('license:logout'),
  },
};

contextBridge.exposeInMainWorld('wangzaiDesktop', wangzaiDesktop);
