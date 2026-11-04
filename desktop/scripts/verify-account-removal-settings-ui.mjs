import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const testResultsRoot = path.join(desktopRoot, 'test-results');
const workRoot = path.join(testResultsRoot, 'account-removal-settings-ui-work');
const dataRoot = path.join(workRoot, 'profile');
const reportPath = path.join(testResultsRoot, 'account-removal-settings-ui-report.json');
const screenshotPath = path.join(testResultsRoot, 'account-removal-settings-ui-final.png');
const databasePath = path.join(dataRoot, 'local-api-data', 'wangzai-local-api.sqlite');
const secretPath = path.join(dataRoot, 'local-api-data', 'local-api-secret.key');
const electronExecutable = path.join(
  desktopRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const parsedCycles = Number.parseInt(
  process.argv.find((argument) => argument.startsWith('--cycles='))?.split('=')[1] || '50',
  10,
);
const cyclesPerModule = Math.max(1, Number.isFinite(parsedCycles) ? parsedCycles : 50);

function fixtureCredential(...parts) {
  return ['account-removal', 'test-credential', ...parts].join('-');
}

const fixtures = Object.freeze({
  ozon_shop: {
    ownerId: 'ui-delete-ozon-shop',
    moduleLabel: 'Ozon 店铺',
    cardTitle: 'UI 删除 Ozon 店铺',
    path: '/api/shops',
    body: {
      id: 'ui-delete-ozon-shop',
      name: 'UI 删除 Ozon 店铺',
      shopAlias: 'UI 删除 Ozon 店铺',
      sellerName: 'UI 删除 Ozon 店铺',
      clientId: 'ui-delete-client-id',
      apiKey: fixtureCredential('ui', 'ozon', 'seed'),
      status: 'active',
    },
    listPath: '/api/shops',
    collectionKey: 'shops',
  },
  cross_border_bus: {
    ownerId: 'cross-border-main',
    moduleLabel: '跨境巴士',
    cardTitle: '',
    path: '/api/logistics/cross-border/accounts',
    body: {
      id: 'cross-border-main',
      name: 'UI 跨境巴士账号',
      userName: 'ui-cross-border-user',
      password: fixtureCredential('ui', 'cross-border', 'seed'),
      status: 'active',
    },
    listPath: '/api/logistics/cross-border/accounts',
    collectionKey: 'accounts',
  },
  promotion_account: {
    ownerId: 'ui-delete-performance',
    moduleLabel: '外部接口',
    cardTitle: 'UI 删除 Performance',
    path: '/api/performance/accounts',
    body: {
      id: 'ui-delete-performance',
      name: 'UI 删除 Performance',
      clientId: 'ui-performance-client',
      clientSecret: fixtureCredential('ui', 'performance', 'seed'),
      status: 'active',
    },
    listPath: '/api/performance/accounts',
    collectionKey: 'accounts',
  },
  purchase_account: {
    ownerId: 'ui-delete-purchase',
    moduleLabel: '拍单账号',
    cardTitle: 'UI 删除采购账号',
    expectedInput: 'ui-purchase-user',
    path: '/api/purchase/accounts',
    body: {
      id: 'ui-delete-purchase',
      name: 'UI 删除采购账号',
      platformName: '1688',
      platformUrl: 'https://www.1688.com/',
      loginAccount: 'ui-purchase-user',
      loginPassword: 'ui-delete-purchase-secret-2d8c',
      status: 'active',
    },
    listPath: '/api/purchase/accounts',
    collectionKey: 'accounts',
  },
  model_api_account: {
    ownerId: 'ui-delete-model-api',
    moduleLabel: '模型接口',
    cardTitle: '',
    expectedInput: 'ui-model-user',
    path: '/api/model-api/accounts',
    body: {
      id: 'ui-delete-model-api',
      apiAlias: 'UI 删除模型接口',
      provider: 'ui-test-provider',
      websiteUrl: 'https://ui-model.invalid/',
      loginAccount: 'ui-model-user',
      apiKey: fixtureCredential('ui', 'model', 'seed'),
      status: 'active',
    },
    listPath: '/api/model-api/accounts',
    collectionKey: 'accounts',
  },
  integration_profile: {
    ownerId: 'ui-delete-integration',
    moduleLabel: '外部接口',
    cardTitle: 'UI 删除外部接口',
    path: '/api/integrations/profiles',
    body: {
      id: 'ui-delete-integration',
      integrationType: 'seerfar-open-api',
      platformName: 'UI 删除外部接口',
      apiType: '市场数据',
      authMode: 'Bearer API Key',
      configStatus: 'saved',
      note: 'isolated Electron deletion fixture',
    },
    listPath: '/api/integrations/profiles',
    collectionKey: 'profiles',
  },
});

const supportedOwnerOrder = Object.freeze([
  'cross_border_bus',
  'purchase_account',
  'model_api_account',
  'promotion_account',
  'integration_profile',
  'ozon_shop',
]);
const requestedOwnerType = String(
  process.argv.find((argument) => argument.startsWith('--owner-type='))?.split('=')[1] || '',
).trim();
if (requestedOwnerType && !supportedOwnerOrder.includes(requestedOwnerType)) {
  throw new Error(`ACCOUNT_REMOVAL_UI_OWNER_TYPE_INVALID:${requestedOwnerType}`);
}
const ownerOrder = Object.freeze(
  requestedOwnerType ? [requestedOwnerType] : [...supportedOwnerOrder],
);

function buildCycleFixture(ownerType, cycle) {
  const template = fixtures[ownerType];
  const suffix = String(cycle).padStart(2, '0');
  const ownerId = ownerType === 'cross_border_bus'
    ? template.ownerId
    : `${template.ownerId}-${suffix}`;
  const title = template.cardTitle ? `${template.cardTitle} ${suffix}` : '';
  const fixtureCredentialValue = fixtureCredential('ui', ownerType, suffix);
  const expectedInput = template.expectedInput ? `${template.expectedInput}-${suffix}` : undefined;
  const body = { ...template.body, id: ownerId };
  if (ownerType === 'ozon_shop') {
    Object.assign(body, {
      name: title,
      shopAlias: title,
      sellerName: title,
      clientId: `ui-delete-client-${suffix}`,
      apiKey: fixtureCredentialValue,
    });
  } else if (ownerType === 'cross_border_bus') {
    Object.assign(body, {
      name: `UI 跨境巴士账号 ${suffix}`,
      userName: `ui-cross-border-user-${suffix}`,
      password: fixtureCredentialValue,
      accountRemovalRebind: cycle > 1,
    });
  } else if (ownerType === 'promotion_account') {
    Object.assign(body, {
      name: title,
      clientId: `ui-performance-client-${suffix}`,
      clientSecret: fixtureCredentialValue,
    });
  } else if (ownerType === 'purchase_account') {
    Object.assign(body, {
      name: title,
      loginAccount: expectedInput,
      loginPassword: fixtureCredentialValue,
    });
  } else if (ownerType === 'model_api_account') {
    Object.assign(body, {
      apiAlias: `UI 删除模型接口 ${suffix}`,
      loginAccount: expectedInput,
      apiKey: fixtureCredentialValue,
    });
  } else if (ownerType === 'integration_profile') {
    Object.assign(body, {
      platformName: title,
      credentials: {
        baseUrl: 'https://api.seerfar.cn',
        apiKey: fixtureCredentialValue,
      },
      note: `isolated Electron deletion fixture ${suffix}`,
    });
  }
  return {
    ...template,
    ownerId,
    cardTitle: title,
    expectedInput,
    body,
    secret: fixtureCredentialValue,
    cycle,
  };
}

function buildSentinelFixture(ownerType) {
  const template = fixtures[ownerType];
  const ownerId = `ui-sentinel-${ownerType}`;
  const body = { ...template.body, id: ownerId };
  if (ownerType === 'ozon_shop') {
    Object.assign(body, {
      name: 'UI 哨兵 Ozon 店铺',
      shopAlias: 'UI 哨兵 Ozon 店铺',
      sellerName: 'UI 哨兵 Ozon 店铺',
      clientId: 'ui-sentinel-ozon-client',
      apiKey: fixtureCredential('ui', 'sentinel', 'ozon'),
    });
  } else if (ownerType === 'cross_border_bus') {
    Object.assign(body, {
      name: 'UI 哨兵跨境账号',
      userName: 'ui-sentinel-cross-border-user',
      password: fixtureCredential('ui', 'sentinel', 'cross-border'),
    });
  } else if (ownerType === 'promotion_account') {
    Object.assign(body, {
      name: 'UI 哨兵 Performance 账号',
      clientId: 'ui-sentinel-performance-client',
      clientSecret: fixtureCredential('ui', 'sentinel', 'performance'),
    });
  } else if (ownerType === 'purchase_account') {
    Object.assign(body, {
      name: 'UI 哨兵采购账号',
      loginAccount: 'ui-sentinel-purchase-user',
      loginPassword: 'ui-sentinel-purchase-secret',
    });
  } else if (ownerType === 'model_api_account') {
    Object.assign(body, {
      apiAlias: 'UI 哨兵模型接口',
      loginAccount: 'ui-sentinel-model-user',
      apiKey: fixtureCredential('ui', 'sentinel', 'model'),
    });
  } else if (ownerType === 'integration_profile') {
    Object.assign(body, {
      platformName: 'UI 哨兵外部接口',
      credentials: {
        baseUrl: 'https://api.seerfar.cn',
        apiKey: fixtureCredential('ui', 'sentinel', 'integration'),
      },
      note: 'must survive every unrelated deletion',
    });
  }
  return { ...template, ownerId, body };
}

function assertOwnedWorkPath(targetPath) {
  const root = `${path.resolve(workRoot)}${path.sep}`.toLowerCase();
  const target = path.resolve(targetPath).toLowerCase();
  assert.ok(target === path.resolve(workRoot).toLowerCase() || target.startsWith(root));
}

function cleanupWorkRoot() {
  assertOwnedWorkPath(workRoot);
  rmSync(workRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

async function terminateChildTree(child) {
  const launchPid = child?.pid || null;
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = async (pid, timeoutMs = 8_000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!isAlive(pid)) return true;
      await delay(100);
    }
    return !isAlive(pid);
  };
  if (process.platform === 'win32') {
    const escapedExecutable = electronExecutable.replaceAll("'", "''");
    const escapedWorkRoot = workRoot.replaceAll("'", "''");
    const querySource = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
@(
  Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -eq '${escapedExecutable}' -and $_.CommandLine -like '*--account-removal-settings-ui-test*') -or
    $_.CommandLine -like '*${escapedWorkRoot}*'
  } | ForEach-Object { [int]$_.ProcessId }
) | ConvertTo-Json -Compress
`;
    const encodedQuery = Buffer.from(querySource, 'utf16le').toString('base64');
    const discoveredPids = await new Promise((resolve) => {
      const query = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedQuery],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let stdout = '';
      query.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      query.once('error', () => resolve([]));
      query.once('exit', () => {
        try {
          const parsed = JSON.parse(stdout.trim() || '[]');
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      });
    });
    const pids = [...new Set([launchPid, ...discoveredPids]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
    const attempts = [];
    for (const pid of pids) {
      for (let attempt = 1; attempt <= 3 && isAlive(pid); attempt += 1) {
        const result = await new Promise((resolve) => {
          const killer = spawn(
            process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
            ['/d', '/s', '/c', `taskkill /pid ${pid} /t /f`],
            { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
          );
          let stdout = '';
          let stderr = '';
          killer.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
          killer.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
          killer.once('exit', (code) => resolve({ pid, attempt, code, stdout, stderr }));
          killer.once('error', (error) => resolve({ pid, attempt, code: -1, error: String(error) }));
        });
        attempts.push(result);
        if (await waitForExit(pid)) break;
      }
      if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        await waitForExit(pid, 5_000);
      }
    }
    return {
      launchPid,
      discoveredPids,
      stopped: pids.every((pid) => !isAlive(pid)),
      attempts,
    };
  }
  if (!launchPid) return { launchPid: null, stopped: true, attempts: [] };
  child.kill('SIGTERM');
  return {
    launchPid,
    stopped: await waitForExit(launchPid),
    attempts: [{ signal: 'SIGTERM' }],
  };
}

function launchElectron({ cdpPort, localApiPort, bridgePort, recoveryRemote }) {
  const child = spawn(electronExecutable, [
    '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    '.',
    '--dashboard-visual-test',
    '--account-removal-settings-ui-test',
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      WANGZAI_DESKTOP_DATA_DIR: dataRoot,
      WANGZAI_LICENSE_MODE: 'off',
      LOCAL_API_PORT: String(localApiPort),
      PURCHASE_SEARCH_BRIDGE_PORT: String(bridgePort),
      WANGZAI_ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE_URL: recoveryRemote.baseUrl,
      WANGZAI_ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE_TOKEN: recoveryRemote.accessToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => { output.stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { output.stderr += chunk.toString('utf8'); });
  return { child, output };
}

async function startLoopbackRecoveryRemote() {
  const accessToken = 'account-removal-ui-test-token';
  const tombstonedOwnerRefs = new Set();
  let requestCount = 0;
  const server = createHttpServer((request, response) => {
    requestCount += 1;
    const authorization = String(request.headers.authorization || '');
    if (authorization !== `Bearer ${accessToken}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/api/recovery/generations') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }
    const purgeMatch = requestUrl.pathname.match(/^\/api\/recovery\/owners\/([^/]+)\/purge$/u);
    if (request.method === 'POST' && purgeMatch) {
      const ownerRef = decodeURIComponent(purgeMatch[1]);
      tombstonedOwnerRefs.add(ownerRef);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        owner_ref: ownerRef,
        tombstoned: true,
        deleted_generation_ids: [],
        remaining_generation_count: 0,
      }));
      return;
    }
    const statusMatch = requestUrl.pathname.match(/^\/api\/recovery\/owners\/([^/]+)\/purge-status$/u);
    if (request.method === 'GET' && statusMatch) {
      const ownerRef = decodeURIComponent(statusMatch[1]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        owner_ref: ownerRef,
        tombstoned: tombstonedOwnerRefs.has(ownerRef),
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken,
    requestCount: () => requestCount,
    tombstoneCount: () => tombstonedOwnerRefs.size,
  };
}

async function waitForTarget(cdpPort, launch, timeoutMs = 45_000, excludedWebSocketUrl = '') {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (launch?.child && launch.child.exitCode !== null) {
      throw new Error(`Electron 提前退出：${launch.child.exitCode}\n${launch.output.stderr.slice(-3000)}`);
    }
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith('app://'));
      if (
        target?.webSocketDebuggerUrl
        && target.webSocketDebuggerUrl !== excludedWebSocketUrl
      ) return target;
    } catch {}
    await delay(150);
  }
  throw new Error(`等待 Electron CDP 超时：${endpoint}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push((message.params.args || [])
          .map((item) => item.value || item.description || '')
          .filter(Boolean)
          .join(' '));
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时：${method}`));
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 30_000, intervalMs = 100) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.evaluate(expression)) return Date.now() - startedAt;
      await delay(intervalMs);
    }
    const body = await this.evaluate(`document.body?.innerText?.slice(0, 4000) || ''`).catch(() => '');
    throw new Error(`等待页面状态超时：${expression}\n${body}`);
  }

  close() {
    this.socket?.close();
  }
}

function visibleButtonExpression(text, rootExpression = 'document') {
  return `Array.from((${rootExpression}).querySelectorAll('button'))
    .find((element) => element.innerText?.trim() === ${JSON.stringify(text)} && element.offsetParent !== null)`;
}

async function requestLocalApi(cdp, pathName, { method = 'GET', body } = {}) {
  const result = await cdp.evaluate(`window.wangzaiDesktop.localApiRequest(${JSON.stringify({
    path: pathName,
    method,
    ...(body === undefined ? {} : { body }),
    timeoutMs: 90000,
  })})`);
  if (!result?.ok) throw new Error(`local-api ${method} ${pathName} 失败：${JSON.stringify(result)}`);
  return result.data;
}

async function openSettings(cdp, moduleLabel) {
  const moduleIdByLabel = {
    'Ozon 店铺': 'ozon',
    跨境巴士: 'crossBorderBus',
    拍单账号: 'purchaseAccount',
    模型接口: 'modelApi',
    外部接口: 'platformApi',
  };
  const isOpen = await cdp.evaluate(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  if (!isOpen) {
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('wangzai-settings-open', {
      detail: { moduleId: ${JSON.stringify(moduleIdByLabel[moduleLabel])} }
    })); true`);
    await cdp.waitFor(`document.querySelector('.shop-settings-backdrop')?.dataset.settingsOpen === 'true'`);
  }
  const alreadyActive = await cdp.evaluate(`Array.from(document.querySelectorAll('.settings-module-tab'))
    .some((element) => element.classList.contains('active')
      && element.innerText?.trim().startsWith(${JSON.stringify(moduleLabel)}))`);
  if (alreadyActive && moduleLabel !== 'Ozon 店铺') {
    await cdp.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('.settings-module-tab'))
        .find((element) => !element.classList.contains('active') && element.offsetParent !== null);
      target?.click();
      return Boolean(target);
    })()`);
    await cdp.waitFor(`!Array.from(document.querySelectorAll('.settings-module-tab'))
      .some((element) => element.classList.contains('active')
        && element.innerText?.trim().startsWith(${JSON.stringify(moduleLabel)}))`);
  }
  await cdp.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.settings-module-tab'))
      .find((element) => element.innerText?.trim().startsWith(${JSON.stringify(moduleLabel)}));
    tab?.click();
    return Boolean(tab);
  })()`);
  await cdp.waitFor(`Array.from(document.querySelectorAll('.settings-module-tab'))
    .some((element) => element.classList.contains('active') && element.innerText?.trim().startsWith(${JSON.stringify(moduleLabel)}))`);
  await cdp.waitFor(`!document.body.innerText.includes('正在准备设置内容')`);
}

async function selectAndInspectFixture(cdp, ownerType, fixture = fixtures[ownerType]) {
  await openSettings(cdp, fixture.moduleLabel);
  const rootExpression = fixture.moduleLabel === 'Ozon 店铺'
    ? `Array.from(document.querySelectorAll('.settings-ozon-panel-host')).find((element) => element.offsetParent !== null)`
    : fixture.moduleLabel === '模型接口'
      ? `Array.from(document.querySelectorAll('.model-api-layout')).find((element) => element.offsetParent !== null)`
      : fixture.moduleLabel === '外部接口'
         ? `Array.from(document.querySelectorAll('.platform-api-layout')).find((element) => element.offsetParent !== null)`
         : `Array.from(document.querySelectorAll('.shop-settings-layout')).find((element) => element.offsetParent !== null && !element.classList.contains('platform-api-layout') && !element.classList.contains('model-api-layout'))`;
  await cdp.waitFor(`(() => {
    const root = ${rootExpression};
    const cards = Array.from(root?.querySelectorAll('.shop-list-item') || []);
    const requestedTitle = ${JSON.stringify(fixture.cardTitle)};
    const selectsByInput = ${JSON.stringify(Boolean(fixture.expectedInput))};
    return requestedTitle && !selectsByInput
      ? cards.some((element) => element.innerText?.includes(requestedTitle))
      : cards.length > 0;
  })()`, 30_000, 100);
  let selection = await cdp.evaluate(`(() => {
    const root = ${rootExpression};
    const cards = Array.from(root?.querySelectorAll('.shop-list-item') || []);
    const requestedTitle = ${JSON.stringify(fixture.cardTitle)};
    const card = requestedTitle
      ? cards.find((element) => element.innerText?.includes(requestedTitle))
      : cards[0];
    card?.click();
    return {
      rootPresent: Boolean(root),
      cardCount: cards.length,
      selected: Boolean(card),
      cardText: card?.innerText || '',
      cardTexts: cards.map((element) => element.innerText || ''),
    };
  })()`);
  assert.equal(selection.rootPresent, true, `${ownerType} 设置根节点缺失：${JSON.stringify(selection)}`);
  if (!selection.selected && fixture.expectedInput) {
    for (let index = 0; index < selection.cardCount; index += 1) {
      await cdp.evaluate(`(() => {
        const root = ${rootExpression};
        const card = root?.querySelectorAll('.shop-list-item')?.[${index}];
        card?.click();
        return Boolean(card);
      })()`);
      let matched = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        matched = await cdp.evaluate(`Array.from((${rootExpression})?.querySelectorAll('input') || [])
          .some((input) => input.value === ${JSON.stringify(fixture.expectedInput)})`);
        if (matched) break;
        await delay(50);
      }
      if (matched) {
        selection = {
          ...selection,
          selected: true,
          cardText: selection.cardTexts[index] || '',
        };
        break;
      }
    }
  }
  assert.equal(selection.selected, true, `${ownerType} 账号没有显示：${JSON.stringify(selection)}`);
  if (fixture.expectedInput) {
    await cdp.waitFor(`Array.from((${rootExpression})?.querySelectorAll('input') || [])
      .some((input) => input.value === ${JSON.stringify(fixture.expectedInput)})`, 15_000);
  }
  if (fixture.expectedMaskedCredential) {
    await cdp.waitFor(`Array.from((${rootExpression})?.querySelectorAll('input') || [])
      .some((input) => input.value.includes('•') || input.placeholder.includes('•'))`, 15_000);
  }
  const inspected = await cdp.evaluate(`(() => {
    const activeTab = Array.from(document.querySelectorAll('.settings-module-tab'))
      .find((element) => element.classList.contains('active'));
    const root = ${rootExpression};
    const cards = Array.from(root?.querySelectorAll('.shop-list-item') || []);
    const requestedTitle = ${JSON.stringify(fixture.cardTitle)};
    const card = requestedTitle
      ? cards.find((element) => element.innerText?.includes(requestedTitle))
      : cards[0];
    const inputElements = Array.from(root?.querySelectorAll('input') || []);
    const inputs = inputElements.map((input) => input.value);
    return {
      activeTab: activeTab?.innerText?.trim() || '',
      rootPresent: Boolean(root),
      cardCount: cards.length,
      selected: Boolean(card),
      cardText: card?.innerText || '',
      inputValues: inputs,
      inputPlaceholders: inputElements.map((input) => input.placeholder),
      deletePresent: Boolean(root?.querySelector('.shop-remove-button')),
      deleteDisabled: Boolean(root?.querySelector('.shop-remove-button')?.disabled),
      errorBoundary: document.body.innerText.includes('页面显示异常'),
      readFailure: Boolean(Array.from(root?.querySelectorAll('p') || [])
        .find((element) => element.innerText?.includes('读取失败'))),
    };
  })()`);
  const state = {
    ...inspected,
    selected: selection.selected,
    cardText: selection.cardText || inspected.cardText,
  };
  assert.equal(state.rootPresent, true, `${ownerType} 设置根节点缺失：${JSON.stringify(state)}`);
  assert.equal(state.selected, true, `${ownerType} 账号没有显示：${JSON.stringify(state)}`);
  assert.equal(state.deletePresent, true, `${ownerType} 删除按钮缺失：${JSON.stringify(state)}`);
  assert.equal(state.deleteDisabled, false, `${ownerType} 删除按钮不可用：${JSON.stringify(state)}`);
  assert.equal(state.errorBoundary, false, `${ownerType} 命中错误边界：${JSON.stringify(state)}`);
  assert.equal(state.readFailure, false, `${ownerType} 显示读取失败：${JSON.stringify(state)}`);
  if (fixture.expectedInput) {
    assert.equal(state.inputValues.includes(fixture.expectedInput), true, `${ownerType} 没有回填已保存账号：${JSON.stringify(state)}`);
  }
  if (fixture.expectedMaskedCredential) {
    assert.equal(
      [...state.inputValues, ...state.inputPlaceholders].some((value) => String(value).includes('•')),
      true,
      `${ownerType} 没有显示已保存凭据掩码：${JSON.stringify(state)}`,
    );
  }
  return state;
}

async function deleteSelectedFixture(cdp, ownerType, fixture = fixtures[ownerType]) {
  await selectAndInspectFixture(cdp, ownerType, fixture);
  const startedAt = Date.now();
  const clicked = await cdp.evaluate(`(() => {
    const activeTab = Array.from(document.querySelectorAll('.settings-module-tab'))
      .find((element) => element.classList.contains('active'));
    const label = activeTab?.innerText?.trim() || '';
    const root = label.startsWith('Ozon 店铺')
      ? Array.from(document.querySelectorAll('.settings-ozon-panel-host')).find((element) => element.offsetParent !== null)
      : label.startsWith('模型接口')
        ? Array.from(document.querySelectorAll('.model-api-layout')).find((element) => element.offsetParent !== null)
        : label.startsWith('外部接口')
          ? Array.from(document.querySelectorAll('.platform-api-layout')).find((element) => element.offsetParent !== null)
          : Array.from(document.querySelectorAll('.shop-settings-layout'))
            .find((element) => element.offsetParent !== null && !element.classList.contains('platform-api-layout') && !element.classList.contains('model-api-layout'));
    const button = root?.querySelector('.shop-remove-button');
    button?.click();
    return Boolean(button && !button.disabled);
  })()`);
  assert.equal(clicked, true, `${ownerType} 删除按钮点击失败`);
  await cdp.waitFor(`Boolean(document.querySelector('#account-removal-dialog-title'))`, 30_000);

  if (ownerType === 'ozon_shop') {
    await cdp.waitFor(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      const stageRoot = document.querySelector('[data-account-removal-stage]');
      return Boolean(dialog && ['completed', 'error'].includes(
        stageRoot?.getAttribute('data-account-removal-stage'),
      ));
    })()`, 180_000, 150);
    const directResult = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      return {
        stage: document.querySelector('[data-account-removal-stage]')
          ?.getAttribute('data-account-removal-stage') || '',
        text: dialog?.innerText || '',
        buttons: Array.from(dialog?.querySelectorAll('button') || []).map((button) => (
          String(button.innerText || '').trim()
        )),
      };
    })()`);
    assert.equal(
      directResult.stage,
      'completed',
      `${ownerType} 一键直删没有完成：${directResult.text}`,
    );
    for (const forbiddenText of [
      '先备份再删除',
      '跳过备份并永久删除',
      '仍然永久删除',
      '确认永久删除',
      '我已核对删除账号和数据范围',
    ]) {
      assert.equal(
        directResult.text.includes(forbiddenText) || directResult.buttons.includes(forbiddenText),
        false,
        `${ownerType} 一键直删仍显示多余步骤：${forbiddenText}`,
      );
    }
    const closed = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      const button = Array.from(dialog?.querySelectorAll('button') || []).find((item) => (
        item.offsetParent !== null
          && !item.disabled
          && String(item.innerText || '').trim() === '关闭'
      ));
      button?.click();
      return Boolean(button);
    })()`);
    assert.equal(closed, true, `${ownerType} 直删完成弹窗缺少关闭按钮`);
    await cdp.waitFor(`!document.querySelector('#account-removal-dialog-title')`);
    return Date.now() - startedAt;
  }

  await cdp.waitFor(`document.querySelector('#account-removal-dialog-title')
    ?.closest('[role="dialog"]')?.innerText?.includes('等待人工确认')`, 30_000);

  let dialogText = '';
  for (let previewAttempt = 1; previewAttempt <= 4; previewAttempt += 1) {
    const skipRequired = await cdp.evaluate(`Boolean(${visibleButtonExpression(
      '跳过备份并永久删除',
      `document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]')`,
    )})`);
    if (skipRequired) {
      await cdp.evaluate(`${visibleButtonExpression(
        '跳过备份并永久删除',
        `document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]')`,
      )}.click(); true`);
      await cdp.waitFor(`Array.from(document.querySelectorAll('[role="dialog"]'))
        .some((dialog) => dialog.innerText?.includes('我了解跳过备份后这些数据可能无法恢复'))`);
      await cdp.evaluate(`(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
          .find((element) => element.innerText?.includes('我了解跳过备份后这些数据可能无法恢复'));
        dialog?.querySelector('input[type="checkbox"]')?.click();
        return true;
      })()`);
      await cdp.evaluate(`${visibleButtonExpression(
        '仍然永久删除',
        `Array.from(document.querySelectorAll('[role="dialog"]')).find((element) => element.innerText?.includes('我了解跳过备份后这些数据可能无法恢复'))`,
      )}.click(); true`);
      await cdp.waitFor(`!Array.from(document.querySelectorAll('[role="dialog"]'))
        .some((dialog) => dialog.innerText?.includes('我了解跳过备份后这些数据可能无法恢复'))`);
    }

    await cdp.waitFor(`document.querySelector('#account-removal-dialog-title')
      ?.closest('[role="dialog"]')?.innerText?.includes('我已核对删除账号和数据范围')`);
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      const checkbox = dialog?.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) checkbox.click();
      return true;
    })()`);
    await cdp.waitFor(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      const button = ${visibleButtonExpression('确认永久删除', 'dialog')};
      return Boolean(button && !button.disabled);
    })()`);
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
      ${visibleButtonExpression('确认永久删除', 'dialog')}?.click();
      return true;
    })()`);
    await cdp.waitFor(`(() => {
      const text = document.querySelector('#account-removal-dialog-title')
        ?.closest('[role="dialog"]')?.innerText || '';
      return text.includes('账号删除已完成')
        || text.includes('删除未完成，可以重试')
        || text.includes('删除预览刚刚发生变化')
        || text.includes('数据发生变化');
    })()`, 90_000, 150);
    dialogText = await cdp.evaluate(`document.querySelector('#account-removal-dialog-title')
      ?.closest('[role="dialog"]')?.innerText || ''`);
    if (dialogText.includes('账号删除已完成')) break;
    if (
      dialogText.includes('删除预览刚刚发生变化')
      || dialogText.includes('数据发生变化')
    ) {
      assert.equal(
        previewAttempt < 4,
        true,
        `${ownerType} 删除预览连续变化，无法在安全屏障内稳定：${dialogText}`,
      );
      continue;
    }
    if (dialogText.includes('删除未完成，可以重试')) break;
    assert.equal(
      previewAttempt < 4,
      true,
      `${ownerType} 删除预览连续变化，无法在安全屏障内稳定：${dialogText}`,
    );
  }
  if (!dialogText.includes('账号删除已完成')) {
    const operationId = dialogText.match(/account_removal_[A-Za-z0-9-]+/u)?.[0] || '';
    if (
      operationId
      && ['purchase_account', 'integration_profile'].includes(ownerType)
      && dialogText.includes('正在清理账号外部数据')
    ) {
      const restartPending = new Error(`${ownerType} 删除需要应用重启后续跑`);
      restartPending.code = 'ACCOUNT_REMOVAL_APP_RESTART_PENDING';
      restartPending.operationId = operationId;
      restartPending.durationMs = Date.now() - startedAt;
      throw restartPending;
    }
    const diagnostics = operationId
      ? {
          operation: await requestLocalApi(
            cdp,
            `/api/account-removal/operations/${encodeURIComponent(operationId)}`,
          ).catch((error) => ({ error: String(error) })),
          protection: await cdp.evaluate(`window.wangzaiDesktop.recoveryRequest({
            command: 'purge-account-owner-protection',
            operationId: ${JSON.stringify(operationId)}
          })`).catch((error) => ({ error: String(error) })),
        }
      : { error: 'operation id missing' };
    throw new Error(`${ownerType} 删除流程失败：${JSON.stringify(diagnostics)}\n${dialogText}`);
  }
  assert.equal(dialogText.includes('删除未完成'), false, `${ownerType} 删除流程未完成`);
  await cdp.waitFor(`(() => {
    const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
    const button = Array.from(dialog?.querySelectorAll('button') || []).find((item) => (
      item.offsetParent !== null
        && !item.disabled
        && String(item.innerText || '').trim() === '关闭'
    ));
    return Boolean(button);
  })()`, 90_000, 150);
  const completionDialogClosed = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('#account-removal-dialog-title')?.closest('[role="dialog"]');
    if (!dialog) return true;
    const button = Array.from(dialog.querySelectorAll('button')).find((item) => (
      item.offsetParent !== null
        && !item.disabled
        && String(item.innerText || '').trim() === '关闭'
    ));
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(completionDialogClosed, true, `${ownerType} 删除完成弹窗缺少可用关闭按钮`);
  await cdp.waitFor(`!document.querySelector('#account-removal-dialog-title')`);
  return Date.now() - startedAt;
}

function findRows(payload, collectionKey) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[collectionKey])) return payload[collectionKey];
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (payload?.data && Array.isArray(payload.data[collectionKey])) return payload.data[collectionKey];
  if (payload?.data && Array.isArray(payload.data.rows)) return payload.data.rows;
  return [];
}

async function waitForSeededOwnerReadback(cdp, fixture, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastRows = [];
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await requestLocalApi(cdp, fixture.listPath).catch(() => null);
    lastRows = findRows(payload, fixture.collectionKey);
    if (lastRows.some((row) => String(row?.id || '').trim() === fixture.ownerId)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `${fixture.ownerId} 写入后未能从 ${fixture.listPath} 回读：${JSON.stringify(lastRows)}`,
  );
}

function scanRawResidue(needles) {
  const databaseFamily = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const matches = [];
  for (const filePath of databaseFamily) {
    if (!existsSync(filePath)) continue;
    const bytes = readFileSync(filePath);
    for (const needle of needles) {
      if (bytes.includes(Buffer.from(needle, 'utf8'))) matches.push({ filePath, needle });
    }
  }
  return matches;
}

async function main() {
  mkdirSync(testResultsRoot, { recursive: true });
  cleanupWorkRoot();
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(path.dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, `${randomBytes(32).toString('base64url')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const ports = {
    cdp: await findFreePort(),
    localApi: await findFreePort(),
    bridge: await findFreePort(),
  };
  const recoveryRemote = await startLoopbackRecoveryRemote();
  const launch = launchElectron({
    cdpPort: ports.cdp,
    localApiPort: ports.localApi,
    bridgePort: ports.bridge,
    recoveryRemote,
  });
  let cdp;
  const report = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    isolatedProfile: dataRoot,
    cyclesPerModule,
    ownerTypeCount: ownerOrder.length,
    totalRequiredUiDeletionCycles: cyclesPerModule * ownerOrder.length,
    totalCompletedUiDeletions: 0,
    modules: [],
    sentinelIsolationChecks: 0,
    sentinelIsolationMismatches: 0,
    rawSecretMatches: [],
    rawDeletedOwnerIdMatches: [],
    consoleErrors: [],
    ignoredElectronReloadConsoleErrors: [],
    recoveryRemoteRequestCount: 0,
    recoveryRemoteTombstoneCount: 0,
    electronProcessId: launch.child.pid,
    electronTermination: null,
    processLogs: {},
    failure: null,
    passed: false,
  };
  const deletedSecrets = [];
  const deletedOwnerIds = new Set();
  const collectedConsoleErrors = [];
  let restartRecoveryCount = 0;
  const sentinels = Object.fromEntries(ownerOrder.map((ownerType) => [
    ownerType,
    buildSentinelFixture(ownerType),
  ]));
  try {
    const target = await waitForTarget(ports.cdp, launch);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.waitFor(`Boolean(window.wangzaiDesktop?.localApiRequest)`, 30_000);
    await cdp.waitFor(`Boolean(document.querySelector('.nav-item'))`, 30_000);

    for (const ownerType of ownerOrder) {
      const sentinel = sentinels[ownerType];
      const saved = await requestLocalApi(cdp, sentinel.path, { method: 'POST', body: sentinel.body });
      assert.ok(saved, `sentinel save failed: ${sentinel.ownerId}`);
    }
    for (const ownerType of ownerOrder) {
      const moduleStartedAt = Date.now();
      const samples = [];
      for (let cycle = 1; cycle <= cyclesPerModule; cycle += 1) {
        const fixture = buildCycleFixture(ownerType, cycle);
        const seeded = await requestLocalApi(cdp, fixture.path, { method: 'POST', body: fixture.body });
        assert.ok(seeded, `${ownerType} 第 ${cycle} 轮账号写入失败`);
        await waitForSeededOwnerReadback(cdp, fixture);
        deletedSecrets.push(fixture.secret);
        if (ownerType !== 'ozon_shop') deletedOwnerIds.add(fixture.ownerId);

        if (ownerType === 'ozon_shop') {
          await cdp.send('Page.reload', { ignoreCache: true });
          await cdp.waitFor(`Boolean(window.wangzaiDesktop?.localApiRequest)`, 45_000);
          await cdp.waitFor(`Boolean(document.querySelector('.nav-item'))`, 45_000);
        }
        const startedAt = Date.now();
        let deletionDurationMs;
        let restartRecovered = false;
        try {
          deletionDurationMs = await deleteSelectedFixture(cdp, ownerType, fixture);
        } catch (error) {
          if (error?.code !== 'ACCOUNT_REMOVAL_APP_RESTART_PENDING' || !error.operationId) throw error;
          collectedConsoleErrors.push(...cdp.consoleErrors.filter(Boolean));
          const previousWebSocketUrl = cdp.url;
          cdp.close();
          const restartedTarget = await waitForTarget(ports.cdp, null, 120_000, previousWebSocketUrl);
          cdp = new CdpClient(restartedTarget.webSocketDebuggerUrl);
          await cdp.connect();
          await cdp.waitFor(`Boolean(window.wangzaiDesktop?.localApiRequest)`, 45_000);
          await cdp.waitFor(`Boolean(document.querySelector('.nav-item'))`, 45_000);
          const recoveryStartedAt = Date.now();
          let operation = null;
          while (Date.now() - recoveryStartedAt < 120_000) {
            try {
              operation = await requestLocalApi(
                cdp,
                `/api/account-removal/operations/${encodeURIComponent(error.operationId)}`,
              );
              if (operation?.status === 'completed' && operation?.phase === 'completed') break;
            } catch {}
            await delay(250);
          }
          assert.equal(operation?.status, 'completed', `${ownerType} 重启后账号删除状态未完成`);
          assert.equal(operation?.phase, 'completed', `${ownerType} 重启后账号删除阶段未完成`);
          deletionDurationMs = Number(error.durationMs || 0) + (Date.now() - recoveryStartedAt);
          restartRecovered = true;
          restartRecoveryCount += 1;
        }
        const payload = await requestLocalApi(cdp, fixture.listPath);
        const rows = findRows(payload, fixture.collectionKey);
        const residue = rows.filter((row) => String(row?.id || '') === fixture.ownerId);
        assert.equal(residue.length, 0, `${ownerType} 第 ${cycle} 轮删除后接口仍返回账号`);

        const sentinel = sentinels[ownerType];
        const sentinelRows = findRows(payload, sentinel.collectionKey);
        const sentinelCount = sentinelRows.filter(
          (row) => String(row?.id || '') === sentinel.ownerId
        ).length;
        report.sentinelIsolationChecks += 1;
        if (sentinelCount !== 1) report.sentinelIsolationMismatches += 1;
        assert.equal(sentinelCount, 1, `${ownerType} 第 ${cycle} 轮误删哨兵账号`);

        samples.push({
          cycle,
          durationMs: Date.now() - startedAt,
          deletionDurationMs,
          restartRecovered,
          readbackResidueCount: residue.length,
          sentinelCount,
        });
        report.totalCompletedUiDeletions += 1;
      }
      report.modules.push({
        ownerType,
        requiredUiDeletionCycles: cyclesPerModule,
        completedUiDeletionCycles: samples.length,
        moduleDurationMs: Date.now() - moduleStartedAt,
        maxCycleMs: Math.max(...samples.map((sample) => sample.durationMs)),
        averageCycleMs: Math.round(
          samples.reduce((sum, sample) => sum + sample.durationMs, 0) / samples.length
        ),
        samples,
      });
    }

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    report.restartRecoveryCount = restartRecoveryCount;
    const rawConsoleErrors = [
      ...collectedConsoleErrors,
      ...cdp.consoleErrors.filter(Boolean),
    ];
    report.ignoredElectronReloadConsoleErrors = rawConsoleErrors.filter((message) => (
      message === 'Electron sandboxed_renderer.bundle.js script failed to run'
      || (
        message.includes("Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null")
        && message.includes('node:electron/js2c/sandbox_bundle')
      )
    ));
    report.consoleErrors = rawConsoleErrors.filter(
      (message) => !report.ignoredElectronReloadConsoleErrors.includes(message),
    );
    assert.equal(report.consoleErrors.length, 0, `Electron 控制台错误：${report.consoleErrors.join(' | ')}`);
    assert.equal(
      report.totalCompletedUiDeletions,
      report.totalRequiredUiDeletionCycles,
      'Electron UI 删除次数没有达到要求'
    );
    assert.equal(report.sentinelIsolationMismatches, 0, '存在跨账号误删');
    report.passed = true;
  } catch (error) {
    report.failure = {
      message: error?.message || String(error),
      stack: error?.stack || '',
    };
    throw error;
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      await delay(300);
      cdp.close();
    }
    report.electronTermination = await terminateChildTree(launch.child);
    assert.equal(report.electronTermination.stopped, true, 'Electron 实机进程树未完全退出');
    await new Promise((resolve) => recoveryRemote.server.close(resolve));
    report.recoveryRemoteRequestCount = recoveryRemote.requestCount();
    report.recoveryRemoteTombstoneCount = recoveryRemote.tombstoneCount();
    report.processLogs = Object.fromEntries([
      'desktop-main',
      'desktop-renderer',
      'local-api',
      'purchase-search-bridge',
    ].map((name) => {
      const filePath = path.join(dataRoot, 'logs', `${name}.log`);
      return [name, existsSync(filePath) ? readFileSync(filePath, 'utf8').slice(-16_384) : ''];
    }));
    report.launchStdout = launch.output.stdout.slice(-16_384);
    report.launchStderr = launch.output.stderr.slice(-16_384);
    await delay(500);
    report.rawSecretMatches = scanRawResidue(deletedSecrets);
    report.rawDeletedOwnerIdMatches = scanRawResidue([...deletedOwnerIds]);
    if (report.rawSecretMatches.length > 0 || report.rawDeletedOwnerIdMatches.length > 0) {
      report.passed = false;
    }
    report.finishedAt = new Date().toISOString();
    report.screenshotPath = screenshotPath;
    report.databaseWorkDirectoryCleaned = false;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    cleanupWorkRoot();
    report.databaseWorkDirectoryCleaned = !existsSync(workRoot);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  assert.equal(report.rawSecretMatches.length, 0, `物理残留：${JSON.stringify(report.rawSecretMatches)}`);
  assert.equal(
    report.rawDeletedOwnerIdMatches.length,
    0,
    `非 Ozon 删除账号标识仍有物理残留：${JSON.stringify(report.rawDeletedOwnerIdMatches)}`
  );
  assert.equal(report.passed, true, 'Electron 六类账号删除实机回归失败');
  console.log(JSON.stringify(report, null, 2));
}

await main();
