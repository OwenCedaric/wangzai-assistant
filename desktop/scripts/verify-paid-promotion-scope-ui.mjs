import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const outputRoot = path.join(workspaceRoot, 'verification', 'paid-promotion-scope-ui-20260819');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const viewport = { width: 1642, height: 958, deviceScaleFactor: 1 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForTarget(port, child, stderr, timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function waitFor(cdp, expression, timeoutMs = 90_000) {
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

async function clickTextButton(cdp, label, selector = 'button, [role="button"]') {
  const clicked = await cdp.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => {
        const text = item.textContent.trim();
        return text === label || text.startsWith(label);
      });
    node?.click();
    return Boolean(node);
  })()`);
  assert(clicked, `找不到操作入口：${label}`);
}

async function inspectToolbar(cdp, selector, expectedLabels) {
  return cdp.evaluate(`(() => {
    const toolbar = document.querySelector(${JSON.stringify(selector)});
    const card = toolbar?.closest('.paid-promotion-list-card')?.getBoundingClientRect();
    const toolbarRect = toolbar?.getBoundingClientRect();
    const fields = toolbar ? [...toolbar.querySelectorAll('.MuiFormControl-root')] : [];
    const fieldRects = fields.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    const overlaps = [];
    for (let left = 0; left < fieldRects.length; left += 1) {
      for (let right = left + 1; right < fieldRects.length; right += 1) {
        const a = fieldRects[left];
        const b = fieldRects[right];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push([left, right]);
      }
    }
    const labels = toolbar ? [...toolbar.querySelectorAll('label')].map((node) => node.textContent.trim()) : [];
    const expected = ${JSON.stringify(expectedLabels)};
    return {
      exists: Boolean(toolbar),
      labels,
      allLabelsPresent: expected.every((label) => labels.includes(label)),
      fieldCount: fields.length,
      fieldRects,
      overlaps,
      horizontalOverflow: Boolean(toolbar && toolbar.scrollWidth > toolbar.clientWidth + 1),
      outsideCard: Boolean(card && toolbarRect && (toolbarRect.left < card.left - 1 || toolbarRect.right > card.right + 1)),
      helperText: toolbar ? [...toolbar.querySelectorAll('.MuiFormHelperText-root')].map((node) => node.textContent.trim()) : [],
    };
  })()`);
}

async function capture(cdp, name) {
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(800);
  const captureExpression = `window.wangzaiDesktop.captureDashboardVisual(${JSON.stringify({
    rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
  })})`;
  await cdp.evaluate(captureExpression);
  await delay(180);
  const result = await cdp.evaluate(captureExpression);
  assert(result?.ok === true && result?.pngBase64, `未取得${name}截图`, result);
  const screenshotPath = path.join(outputRoot, `${name}.png`);
  await fs.writeFile(screenshotPath, Buffer.from(result.pngBase64, 'base64'));
  return screenshotPath;
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const [cdpPort, localApiPort, bridgePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const stderr = { value: '' };
  const child = spawn(
    electronExecutable,
    [
      '--disable-background-networking',
      '--disable-http-cache',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      '.',
      '--dashboard-visual-test',
    ],
    {
      cwd: desktopRoot,
      windowsHide: true,
      env: {
        ...process.env,
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
    await waitFor(cdp, `document.readyState === 'complete' && Boolean(document.querySelector('.app-root'))`, 45_000);
    await clickTextButton(cdp, '付费推广');
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-page'))`, 45_000);
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-section-tabs'))`, 120_000);

    const evidence = {
      viewport: await cdp.evaluate(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`),
      stylesheets: await cdp.evaluate(`[...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.href)`),
      product: null,
      objects: null,
      search: null,
      stats: null,
      screenshots: {},
    };

    await clickTextButton(cdp, '商品投放', '.paid-promotion-section-tabs button');
    await waitFor(cdp, `document.querySelector('.paid-promotion-workspace-grid')?.classList.contains('tab-products')`);
    evidence.product = await inspectToolbar(cdp, '.paid-promotion-workspace-grid.tab-products .paid-promotion-product-filter-row', [
      '搜索商品',
      '写入目标计划',
      '排序',
      '方向',
    ]);
    evidence.screenshots.product = await capture(cdp, 'PRODUCT_SCOPE');

    await clickTextButton(cdp, '投放对象', '.paid-promotion-section-tabs button');
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-workspace-grid.tab-objects .paid-promotion-scope-toolbar'))`);
    evidence.objects = await inspectToolbar(cdp, '.paid-promotion-workspace-grid.tab-objects .paid-promotion-scope-toolbar', [
      '选择计划',
      '选择商品',
    ]);
    evidence.screenshots.objects = await capture(cdp, 'OBJECT_SCOPE');

    await clickTextButton(cdp, '搜索推广', '.paid-promotion-section-tabs button');
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-workspace-grid.tab-search .paid-promotion-product-filter-row'))`);
    evidence.search = await inspectToolbar(cdp, '.paid-promotion-workspace-grid.tab-search .paid-promotion-product-filter-row', [
      '查看计划',
      '搜索商品',
      '排序',
      '方向',
    ]);
    evidence.search.scopeCopyVisible = await cdp.evaluate(`document.querySelector('.paid-promotion-workspace-grid.tab-search')?.innerText.includes('全店搜索推广商品') === true`);
    evidence.screenshots.search = await capture(cdp, 'SEARCH_SCOPE');

    await clickTextButton(cdp, '统计报表', '.paid-promotion-section-tabs button');
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-workspace-grid.tab-stats .paid-promotion-report-head-actions'))`);
    evidence.stats = await inspectToolbar(cdp, '.paid-promotion-workspace-grid.tab-stats .paid-promotion-report-head-actions', [
      '统计范围',
    ]);
    evidence.stats.scopeMovedToHeader = await cdp.evaluate(`
      Boolean(document.querySelector('.paid-promotion-report-head-actions .paid-promotion-report-head-scope'))
      && !document.querySelector('.paid-promotion-report-scope-row')
    `);
    evidence.screenshots.stats = await capture(cdp, 'REPORT_SCOPE');
    await clickTextButton(cdp, '商品效果', '.paid-promotion-report-switcher button');
    await waitFor(cdp, `Boolean(document.querySelector('.paid-promotion-report-head-actions .paid-promotion-report-head-product-filter'))`);
    evidence.statsProductFilter = await inspectToolbar(cdp, '.paid-promotion-workspace-grid.tab-stats .paid-promotion-report-head-actions', [
      '筛选商品',
      '统计范围',
    ]);
    evidence.statsProductFilter.movedToHeader = await cdp.evaluate(`
      Boolean(document.querySelector('.paid-promotion-report-head-actions .paid-promotion-report-head-product-filter'))
      && !document.querySelector('.paid-promotion-report-product-filter-row')
    `);
    evidence.stats.scopeCaptionVisible = await cdp.evaluate(`document.querySelector('.paid-promotion-report-focus-title')?.innerText.includes('全部计划') === true`);
    evidence.stats.reportTabs = await cdp.evaluate(`[...document.querySelectorAll('.paid-promotion-report-switcher button')].map((node) => ({
      label: node.textContent.trim(),
      active: node.classList.contains('active'),
      ariaSelected: node.getAttribute('aria-selected'),
      background: getComputedStyle(node).backgroundColor,
    }))`);
    evidence.stats.activeStyleDebug = await cdp.evaluate(`(() => {
      const node = document.querySelector('.paid-promotion-report-switcher [role="tab"][aria-selected="true"]');
      const rules = [];
      const visit = (items) => {
        for (const rule of items || []) {
          if (rule.cssRules) visit(rule.cssRules);
          if (!rule.selectorText || !node?.matches(rule.selectorText)) continue;
          const background = rule.style?.getPropertyValue('background') || rule.style?.getPropertyValue('background-color');
          if (background) rules.push({
            selector: rule.selectorText,
            background,
            priority: rule.style.getPropertyPriority('background') || rule.style.getPropertyPriority('background-color'),
          });
        }
      };
      for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules); } catch {}
      }
      return {
        outerHTML: node?.outerHTML || '',
        matchesDirect: node?.matches('.paid-promotion-report-switcher > button.active') || false,
        matchesAria: node?.matches('.paid-promotion-report-switcher [role="tab"][aria-selected="true"]') || false,
        rules,
      };
    })()`);
    evidence.screenshots.statsProductFilter = await capture(cdp, 'REPORT_PRODUCT_FILTER');

    for (const [name, result] of Object.entries({
      product: evidence.product,
      objects: evidence.objects,
      search: evidence.search,
      stats: evidence.stats,
      statsProductFilter: evidence.statsProductFilter,
    })) {
      assert(result.exists, `${name} 范围工具栏不存在`, result);
      assert(result.allLabelsPresent, `${name} 范围控件不完整`, result);
      assert(result.overlaps.length === 0, `${name} 范围控件互相重叠`, result);
      assert(!result.horizontalOverflow, `${name} 范围工具栏出现横向滚动`, result);
      assert(!result.outsideCard, `${name} 范围工具栏超出卡片`, result);
    }
    assert(evidence.search.scopeCopyVisible, '搜索推广没有解释查看范围和写入范围', evidence.search);
    assert(evidence.stats.scopeMovedToHeader, '统计范围没有移动到报表右上角', evidence.stats);
    assert(evidence.statsProductFilter.movedToHeader, '商品筛选没有移动到报表右上角', evidence.statsProductFilter);
    assert(evidence.stats.scopeCaptionVisible, '统计报表没有显示当前统计范围', evidence.stats);
    assert(
      evidence.stats.reportTabs.filter((item) => item.active).length === 1
        && evidence.stats.reportTabs.find((item) => item.active)?.label === '商品效果'
        && evidence.stats.reportTabs.find((item) => item.active)?.ariaSelected === 'true'
        && evidence.stats.reportTabs.find((item) => item.active)?.background === 'rgb(255, 255, 255)',
      '统计报表选中态与当前报表不一致',
      evidence.stats.reportTabs
    );

    evidence.generatedAt = new Date().toISOString();
    const reportPath = path.join(outputRoot, 'paid-promotion-scope-ui.json');
    await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath, ...evidence }, null, 2)}\n`);
  } catch (error) {
    throw new Error(`${error.message}\nElectron stderr:\n${stderr.value.slice(-6000)}`);
  } finally {
    cdp?.close();
    await killTree(child.pid);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
