import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDatabase } from '../../local-api/src/db/database.js';
import { createExchangeRateCacheRepository } from '../../local-api/src/db/repositories/exchangeRateCacheRepository.js';
import { createPerformanceSnapshotRepository } from '../../local-api/src/db/repositories/performanceSnapshotRepository.js';
import { seedRendererPerformanceFixture } from './performanceFixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const outputRoot = path.join(workspaceRoot, 'verification', 'dashboard-home-ui-20260813');
const screenshotPath = path.join(outputRoot, 'DASHBOARD_HOME_FINAL.png');
const evidencePath = path.join(outputRoot, 'DASHBOARD_HOME_FINAL.json');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const viewport = { width: 1642, height: 958, deviceScaleFactor: 1 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shanghaiDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function seedDashboardPromotionFixture(databasePath, shopId) {
  const { db } = initializeDatabase({ database: { path: databasePath, enableWal: true, busyTimeoutMs: 5000 } });
  const accountId = 'dashboard-visual-performance';
  const date = shanghaiDateKey();
  const timestamp = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO performance_accounts (
        id, name, status, shop_id, client_id, client_secret_encrypted,
        campaign_count, statistics_task_count, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, 3, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'active', shop_id = excluded.shop_id, client_id = excluded.client_id,
        client_secret_encrypted = excluded.client_secret_encrypted, updated_at = excluded.updated_at
    `).run(accountId, '首页实机推广账号', shopId, 'dashboard-visual-client', 'fixture-secret-present', timestamp, timestamp);
    createExchangeRateCacheRepository(db).saveRecords({
      records: [{
        requestedDate: date,
        date,
        mode: 'daily',
        rubToCnyRate: 0.08,
        source: 'dashboard-visual-fixture',
        fetchedAt: timestamp,
      }],
    });
    createPerformanceSnapshotRepository(db).saveSnapshot(
      { values: { accountId, shopId, dateFrom: date, dateTo: date, readDepth: 'dashboard' } },
      {
        ok: true,
        readDepth: 'dashboard',
        finishedAt: timestamp,
        summary: { total: 3, spent: 125, revenue: 625, orders: 4 },
        campaigns: [
          { id: 'visual-campaign-1', title: '首页实机推广计划', budgetRemaining: 100 },
        ],
        products: [],
        objects: [],
        dataSets: {},
        readIssues: [],
      },
    );
  } finally {
    db.close();
  }
}

function assert(condition, message, context = null) {
  if (condition) return;
  throw new Error(`${message}${context ? `\n${JSON.stringify(context, null, 2)}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForTarget(port, child, stderr) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 40_000) {
    assert(child.exitCode === null, 'Electron 在页面就绪前退出', { stderr: stderr.value.slice(-3000) });
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith('app://'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await delay(150);
  }
  throw new Error('等待 Electron CDP 页面超时');
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function waitFor(cdp, expression, timeoutMs = 40_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await cdp.evaluate(expression).catch(() => false)) return;
    await delay(180);
  }
  throw new Error(`页面状态等待超时：${expression}`);
}

async function killTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-dashboard-home-'));
  const fixture = await seedRendererPerformanceFixture({ dataRoot, products: 80, orders: 24 });
  seedDashboardPromotionFixture(fixture.databasePath, fixture.shopId);
  const [cdpPort, localApiPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const stderr = { value: '' };
  const child = spawn(
    electronExecutable,
    ['--in-process-gpu', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '.', '--dashboard-visual-test'],
    {
      cwd: desktopRoot,
      windowsHide: true,
      env: {
        ...process.env,
        WANGZAI_DESKTOP_DATA_DIR: dataRoot,
        WANGZAI_LICENSE_MODE: 'off',
        LOCAL_API_PORT: String(localApiPort),
        PURCHASE_SEARCH_BRIDGE_PORT: String(bridgePort),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  child.stderr.on('data', (chunk) => {
    stderr.value += chunk.toString('utf8');
  });

  let cdp;
  try {
    const target = await waitForTarget(cdpPort, child, stderr);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false });
    await waitFor(cdp, `Boolean(document.querySelector('[data-testid="dashboard-overview-root"]'))`);
    await waitFor(cdp, `document.querySelectorAll('[data-testid="dashboard-kpi-card"]').length === 6`);
    await waitFor(
      cdp,
      `document.querySelector('[data-testid="dashboard-promotion-strip"]')?.innerText.includes('推广投入产出比') && !document.querySelector('[data-testid="dashboard-promotion-strip"]')?.innerText.includes('正在更新')`
    );
    await delay(800);

    const interaction = await cdp.evaluate(`(async () => {
      const labels = ['订单量', '净利润', '销售额'];
      const clicked = [];
      for (const label of labels) {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
        if (!button) continue;
        button.click();
        clicked.push(label);
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      return clicked;
    })()`);

    const evidence = await cdp.evaluate(`(() => {
      const root = document.querySelector('[data-testid="dashboard-overview-root"]');
      const rect = (node) => {
        const value = node?.getBoundingClientRect();
        return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      const kpis = [...document.querySelectorAll('[data-testid="dashboard-kpi-card"]')].map(rect);
      const overlap = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      const kpiOverlaps = [];
      for (let i = 0; i < kpis.length; i += 1) for (let j = i + 1; j < kpis.length; j += 1) if (overlap(kpis[i], kpis[j])) kpiOverlaps.push([i, j]);
      const text = root?.innerText || '';
      const chips = [...root.querySelectorAll('.MuiChip-root')].map((node) => ({
        label: node.innerText.trim(),
        borderRadius: getComputedStyle(node).borderRadius,
      }));
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        root: rect(root),
        kpis,
        kpiOverlaps,
        promotion: rect(document.querySelector('[data-testid="dashboard-promotion-strip"]')),
        operations: rect(document.querySelector('[data-testid="dashboard-operations-card"]')),
        stores: rect(document.querySelector('[data-testid="dashboard-store-compare-card"]')),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        errorBoundary: document.body.innerText.includes('页面显示异常'),
        hasInternalCopy: /SQLite|本地数据|本地快照|不受日期筛选影响/.test(text),
        hasEnglishMetricLabels: /\b(?:ACOS|ROAS|CNY|RUB)\b/.test(text),
        hasRequiredChineseMetrics: ['推广费占比', '推广投入产出比'].every((label) => text.includes(label)),
        hasConnectedPromotionValues: ['¥10.00', '4', '¥50.00', '20.00%', '5.00', '¥8.00'].every((value) => text.includes(value)),
        chips,
        allChipsUseSmallRadius: chips.every((chip) => Number.parseFloat(chip.borderRadius) <= 8),
        hasRequiredSections: ['付费推广', '销售与利润趋势', '经营待办', '店铺经营对比', '经营提示', '最新订单'].every((label) => text.includes(label)),
        bodyText: text.slice(0, 5000),
      };
    })()`);
    evidence.interaction = interaction;
    assert(evidence.hasRequiredSections, '首页关键区块不完整', evidence);
    assert(!evidence.horizontalOverflow, '首页存在横向溢出', evidence);
    assert(!evidence.errorBoundary, '首页进入错误边界', evidence);
    assert(!evidence.hasInternalCopy, '首页暴露内部技术词语', evidence);
    assert(!evidence.hasEnglishMetricLabels, '首页仍存在英文指标名称', evidence);
    assert(evidence.hasRequiredChineseMetrics, '首页缺少中文推广指标名称', evidence);
    assert(evidence.hasConnectedPromotionValues, '首页推广指标未全部接入真实结构化数据', evidence);
    assert(evidence.allChipsUseSmallRadius, '首页仍存在胶囊型提示标签', evidence.chips);
    assert(evidence.kpiOverlaps.length === 0, '首页 KPI 卡片互相重叠', evidence.kpiOverlaps);
    assert(evidence.kpis.every((row) => row?.width > 120 && row?.height > 100), '首页 KPI 卡片尺寸异常', evidence.kpis);
    assert(interaction.length === 3, '趋势切换交互不完整', interaction);

    const capture = await cdp.evaluate(`window.wangzaiDesktop.captureDashboardVisual(${JSON.stringify({
      rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    })})`);
    assert(capture?.ok === true && capture?.pngBase64, 'Electron capturePage 没有返回首页截图', capture);
    await fs.writeFile(screenshotPath, Buffer.from(capture.pngBase64, 'base64'));
    evidence.screenshot = screenshotPath;
    evidence.generatedAt = new Date().toISOString();
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, screenshotPath, evidencePath, interaction, viewport: evidence.viewport }, null, 2)}\n`);
  } finally {
    cdp?.close();
    await killTree(child.pid);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
