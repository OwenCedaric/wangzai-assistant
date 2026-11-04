import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const realDataRoot = path.join(process.env.APPDATA, 'wangzai-desktop');
const resultRoot = path.join(workspaceRoot, 'verification', 'follow-seller-defense-live');
const workRoot = path.join(resultRoot, 'runtime');
const databasePath = path.join(workRoot, 'local-api-data', 'wangzai-local-api.sqlite');
const reportPath = path.join(resultRoot, 'report.json');
const screenshotPath = path.join(resultRoot, 'read-only-scan.png');
const realDatabasePath = path.join(realDataRoot, 'local-api-data', 'wangzai-local-api.sqlite');
const migrationsRoot = path.join(workspaceRoot, 'local-api', 'src', 'db', 'migrations');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const sellerOwnerRef = '8d0c02f14176f664d1b45bf2419981f9c305dfb0';
const shopId = 'ozon-shop-example-01';
const sku = '4146104794';
const desktopProfileId = '8781c0a3-ec12-4d35-b255-d117e4038806';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function prepareDatabase() {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    readdirSync(migrationsRoot)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .sort()
      .forEach((name) => {
        db.exec(readFileSync(path.join(migrationsRoot, name), 'utf8').replace(/^\uFEFF/u, ''));
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
          .run(name.replace(/\.sql$/u, ''), name);
      });
    db.exec(`ATTACH DATABASE ${quoteSql(realDatabasePath)} AS source;`);
    db.exec('PRAGMA foreign_keys = OFF;');
    const product = db.prepare(`
      SELECT id FROM source.ozon_products
       WHERE shop_id = ? AND sku = ? AND is_stale = 0
       LIMIT 1
    `).get(shopId, sku);
    assert.ok(product?.id, `真实数据库未找到 SKU ${sku}`);
    const productIdentityId = String(product.id);
    const copy = (table, where) => db.exec(`INSERT INTO main.${table} SELECT * FROM source.${table} WHERE ${where};`);
    copy('shops', `id = ${quoteSql(shopId)}`);
    copy('integration_profiles', `integration_type = 'ozon-browser-session' AND shop_id = ${quoteSql(shopId)}`);
    copy('product_identities', `product_identity_id = ${quoteSql(productIdentityId)}`);
    copy('ozon_products', `id = ${quoteSql(productIdentityId)}`);
    for (const table of [
      'product_status_facts',
      'product_detail_facts',
      'product_attribute_facts',
      'product_image_facts',
    ]) copy(table, `product_identity_id = ${quoteSql(productIdentityId)}`);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('DETACH DATABASE source;');
    return { productIdentityId };
  } finally {
    db.close();
  }
}

function prepareBrowserProfile() {
  writeFileSync(path.join(workRoot, 'profile.json'), `${JSON.stringify({
    schemaVersion: 1,
    profileId: desktopProfileId,
    createdAt: new Date().toISOString(),
    dataRootFingerprint: createHash('sha256').update(`wangzai-data-root:v1:${workRoot}`, 'utf8').digest('hex'),
    databaseInitializedAt: new Date().toISOString(),
    databaseRecoveryRequiredAt: '',
  }, null, 2)}\n`, 'utf8');
  copyFileSync(path.join(realDataRoot, 'Local State'), path.join(workRoot, 'Local State'));
  const browserRoot = path.join(workRoot, 'purchase-browser');
  mkdirSync(browserRoot, { recursive: true });
  copyFileSync(
    path.join(realDataRoot, 'purchase-browser', 'profiles.enc.json'),
    path.join(browserRoot, 'profiles.enc.json'),
  );
  const sourceProfile = path.join(realDataRoot, 'purchase-browser', 'cef-cache-root', sellerOwnerRef);
  const targetProfile = path.join(browserRoot, 'cef-cache-root', sellerOwnerRef);
  mkdirSync(targetProfile, { recursive: true });
  for (const name of [
    'Network',
    'Local Storage',
    'Session Storage',
    'Preferences',
    'Secure Preferences',
    'Web Data',
    'Web Data-journal',
  ]) {
    const source = path.join(sourceProfile, name);
    if (existsSync(source)) cpSync(source, path.join(targetProfile, name), { recursive: true, force: true });
  }
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
        this.consoleErrors.push((message.params.args || []).map((item) => item.value || item.description || '').join(' '));
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
      }, 180_000);
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.evaluate(expression)) return Date.now() - startedAt;
      await delay(200);
    }
    const text = await this.evaluate("document.body?.innerText?.slice(0,6000)||''").catch(() => '');
    throw new Error(`等待页面状态超时：${expression}\n${text}`);
  }

  close() {
    this.socket?.close();
  }
}

async function waitForTarget(port, child, output) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 90_000) {
    if (child.exitCode !== null) throw new Error(`Electron 提前退出：${child.exitCode}\n${output.stderr}`);
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith('app://'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await delay(200);
  }
  throw new Error('等待 Electron CDP 超时');
}

async function terminateTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

async function requestLocalApi(cdp, pathname) {
  const result = await cdp.evaluate(`window.wangzaiDesktop.localApiRequest(${JSON.stringify({
    path: pathname,
    method: 'GET',
    timeoutMs: 30_000,
  })})`);
  if (!result?.ok) throw new Error(`local-api 失败：${JSON.stringify(result)}`);
  return result.data;
}

async function main() {
  mkdirSync(resultRoot, { recursive: true });
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  const fixture = prepareDatabase();
  prepareBrowserProfile();
  const ports = { cdp: await findFreePort(), localApi: await findFreePort(), bridge: await findFreePort() };
  const child = spawn(electronExecutable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${ports.cdp}`,
    '.',
    '--dashboard-visual-test',
  ], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      WANGZAI_DESKTOP_DATA_DIR: workRoot,
      WANGZAI_LICENSE_MODE: 'off',
      LOCAL_API_PORT: String(ports.localApi),
      PURCHASE_SEARCH_BRIDGE_PORT: String(ports.bridge),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => { output.stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { output.stderr += chunk.toString('utf8'); });
  let cdp;
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    mode: 'isolated-copy-of-real-profile-read-only',
    shopId,
    sku,
    productIdentityId: fixture.productIdentityId,
    ozonWriteExecuted: false,
    passed: false,
  };
  try {
    const target = await waitForTarget(ports.cdp, child, output);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.waitFor("Boolean(window.wangzaiDesktop?.localApiRequest)&&Boolean(document.querySelector('.nav-item'))", 90_000);
    await cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.nav-item')).find((node) => node.innerText?.includes('剔除跟卖'));
      item?.click();
      return Boolean(item);
    })()`);
    await cdp.waitFor("document.body.innerText.includes('输入一个货号即可巡查')", 45_000);
    await cdp.evaluate(`(() => {
      const input = Array.from(document.querySelectorAll('input')).find((node) => node.placeholder?.includes('只输入一个标识'));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(sku)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await cdp.waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.innerText?.trim() === '检查跟卖' && !button.disabled)`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.innerText?.trim() === '检查跟卖')?.click(); true`);
    await cdp.waitFor(`document.body.innerText.includes('巡查完成，') || document.querySelector('[role="alert"]')?.innerText`, 180_000);
    const pageState = await cdp.evaluate(`(() => ({
      bodyText: document.body.innerText.slice(0, 12000),
      alertText: Array.from(document.querySelectorAll('[role="alert"]')).map((node) => node.innerText).join(' | '),
      rowText: Array.from(document.querySelectorAll('tbody tr')).map((node) => node.innerText).join('\\n'),
    }))()`);
    assert.match(pageState.alertText, /巡查完成/u, `真实巡查未完成：${pageState.alertText}`);
    const overview = await requestLocalApi(cdp, `/api/follow-seller-defense/overview?shopId=${encodeURIComponent(shopId)}&limit=20`);
    const targetCase = (overview.cases || []).find((item) => String(item.sku) === sku);
    assert.ok(targetCase, '真实巡查没有生成持久化案例');
    assert.equal(Number.isFinite(Number(targetCase.followCountBefore)), true, '真实巡查没有返回可确认的跟卖数量');
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    Object.assign(report, {
      passed: true,
      finishedAt: new Date().toISOString(),
      followCount: Number(targetCase.followCountBefore),
      status: targetCase.status,
      offerId: targetCase.offerId,
      alertText: pageState.alertText,
      screenshotPath,
      consoleErrors: cdp.consoleErrors,
    });
  } catch (error) {
    Object.assign(report, {
      finishedAt: new Date().toISOString(),
      failure: { message: error?.message || String(error), stack: error?.stack || '' },
      launchStdout: output.stdout.slice(-8000),
      launchStderr: output.stderr.slice(-8000),
      consoleErrors: cdp?.consoleErrors || [],
    });
    throw error;
  } finally {
    cdp?.close();
    await terminateTree(child.pid);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
