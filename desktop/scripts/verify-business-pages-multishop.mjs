import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9223);
const rounds = Math.max(1, Number(process.argv[3] || 2));
const pages = [
  {
    id: 'sales-orders',
    label: '销售订单',
    toolbarSelector: '.sales-order-filter-toolbar:not(.after-sales-order-filter-toolbar):not(.purchase-order-filter-toolbar)',
    tableSelector: '.sales-orders-table:not(.after-sales-orders-table)',
    shopCellSelector: '.sales-order-shop-value',
  },
  {
    id: 'after-sales',
    label: '售后订单',
    toolbarSelector: '.after-sales-order-filter-toolbar',
    tableSelector: '.after-sales-orders-table',
    shopCellSelector: '.sales-order-shop-cell',
  },
  {
    id: 'purchase-orders',
    label: '拍单管理',
    toolbarSelector: '.purchase-order-filter-toolbar',
    tableSelector: '.purchase-orders-table',
    shopCellSelector: '.purchase-order-shop-cell',
  },
  {
    id: 'profit',
    label: '利润核算',
    toolbarSelector: '.profit-filter-toolbar',
    tableSelector: '.profit-orders-table',
    shopCellSelector: '.profit-order-shop-cell',
  },
];

const endpoint = `http://127.0.0.1:${port}/json`;
const targets = await fetch(endpoint).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到可用的 Electron CDP 页面：${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeoutId);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeoutId });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 30_000, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

const visibleElementSource = `(element) => {
  if (!element || element.closest('[hidden]')) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.pointerEvents !== 'none';
}`;

async function closeBlockingDialog() {
  await evaluate(`(() => {
    const close = document.querySelector(
      '.shop-settings-backdrop[data-settings-open="true"] [aria-label="关闭店铺管理弹窗"], [aria-label="关闭数据说明"]'
    );
    if (!close) return false;
    close.click();
    return true;
  })()`);
}

async function openPage(page) {
  const clicked = await evaluate(`(() => {
    const visible = ${visibleElementSource};
    const label = ${JSON.stringify(page.label)};
    const target = Array.from(document.querySelectorAll('.nav-item, .subnav-item'))
      .find((element) => visible(element) && element.innerText?.trim() === label);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到页面入口：${page.label}`);
  await waitFor(`(() => {
    const visible = ${visibleElementSource};
    return Array.from(document.querySelectorAll(${JSON.stringify(page.toolbarSelector)})).some(visible);
  })()`);
}

async function openShopOptions(page) {
  const opened = await evaluate(`(() => {
    const visible = ${visibleElementSource};
    const toolbar = Array.from(document.querySelectorAll(${JSON.stringify(page.toolbarSelector)})).find(visible);
    const select = toolbar?.querySelector('[role="combobox"]');
    if (!select) return false;
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`);
  if (!opened) throw new Error(`${page.label} 店铺筛选不存在`);
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`);
}

async function readShopOptions(page) {
  await openShopOptions(page);
  const options = await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((option) => ({
    value: option.getAttribute('data-value') || '',
    text: option.innerText.trim(),
    name: option.innerText.trim().split(/\\r?\\n/u)[0] || '全部店铺',
  }))`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`document.querySelectorAll('[role="option"]').length === 0`);
  return options;
}

async function readPageState(page) {
  return evaluate(`(() => {
    const visible = ${visibleElementSource};
    const toolbar = Array.from(document.querySelectorAll(${JSON.stringify(page.toolbarSelector)})).find(visible);
    const panel = toolbar?.closest('.page-panel');
    const table = Array.from(panel?.querySelectorAll(${JSON.stringify(page.tableSelector)}) || []).find(visible);
    const shopLabels = Array.from(table?.querySelectorAll(${JSON.stringify(page.shopCellSelector)}) || [])
      .map((cell) => cell.innerText.trim().split(/\\r?\\n/u)[0])
      .filter(Boolean);
    const text = panel?.innerText || '';
    const summary = panel?.querySelector('.sales-order-pagination-summary')?.innerText.trim() || '';
    const totalMatch = summary.match(/共\\s*([\\d,]+)\\s*条/u);
    return {
      selectedText: toolbar?.querySelector('[role="combobox"]')?.innerText.trim() || '',
      rowCount: shopLabels.length,
      shopLabels: [...new Set(shopLabels)],
      total: totalMatch ? Number(totalMatch[1].replaceAll(',', '')) : 0,
      summary,
      errorTerms: ['页面显示异常', '读取失败', '本地 API 请求超时', '无法连接本地 API']
        .filter((term) => text.includes(term)),
      hasNaN: /(^|\\s)NaN($|\\s)/u.test(text),
      hasUndefined: /(^|\\s)undefined($|\\s)/u.test(text),
    };
  })()`);
}

async function selectShop(page, option, expectedShopLabel = '', expectedTotal = 0) {
  await openShopOptions(page);
  const clicked = await evaluate(`(() => {
    const value = ${JSON.stringify(option.value)};
    const text = ${JSON.stringify(option.text)};
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const target = options.find((item) => (item.getAttribute('data-value') || '') === value)
      || options.find((item) => item.innerText.trim() === text);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${page.label} 店铺选项不存在：${option.name}`);
  await waitFor(`document.querySelectorAll('[role="option"]').length === 0`);

  const startedAt = Date.now();
  let state = null;
  while (Date.now() - startedAt < 30_000) {
    state = await readPageState(page);
    const selected = state.selectedText.includes(option.name);
    const allShops = option.value === 'all' || option.value === '';
    const singleShopReady =
      state.rowCount > 0
      && state.shopLabels.length === 1
      && (!expectedShopLabel || state.shopLabels[0] === expectedShopLabel)
      && (!expectedTotal || state.total === expectedTotal);
    const allShopsReady = state.rowCount > 0 && (!expectedTotal || state.total === expectedTotal);
    if (selected && (allShops ? allShopsReady : singleShopReady)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state || !state.selectedText.includes(option.name)) {
    throw new Error(`${page.label} 店铺筛选回显失败：${JSON.stringify({ option, state })}`);
  }
  const allShops = option.value === 'all' || option.value === '';
  if (!allShops && (state.rowCount < 1 || state.shopLabels.length !== 1)) {
    throw new Error(`${page.label} 单店数据为空或混入其他店铺：${JSON.stringify({ option, state })}`);
  }
  if (expectedShopLabel && state.shopLabels[0] !== expectedShopLabel) {
    throw new Error(`${page.label} 单店数据与已验证店铺不一致：${JSON.stringify({ option, expectedShopLabel, state })}`);
  }
  if (expectedTotal && state.total !== expectedTotal) {
    throw new Error(`${page.label} 店铺汇总数量不一致：${JSON.stringify({ option, expectedTotal, state })}`);
  }
  if (state.errorTerms.length || state.hasNaN || state.hasUndefined) {
    throw new Error(`${page.label} 切换店铺后页面异常：${JSON.stringify({ option, state })}`);
  }
  return { durationMs: Date.now() - startedAt, ...state };
}

await send('Page.enable');
await send('Runtime.enable');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await closeBlockingDialog();

const expectedShopLabels = new Map();
const expectedPageTotals = new Map();
const observations = [];
for (const page of pages) {
  await openPage(page);
  const options = await readShopOptions(page);
  if (options.length < 2) throw new Error(`${page.label} 店铺选项不足：${JSON.stringify(options)}`);
  const orderedOptions = [
    ...options.filter((option) => option.value !== 'all' && option.value !== ''),
    ...options.filter((option) => option.value === 'all' || option.value === ''),
  ];
  for (let round = 1; round <= rounds; round += 1) {
    for (const option of orderedOptions) {
      const allShops = option.value === 'all' || option.value === '';
      const expectedShopLabel = allShops ? '' : expectedShopLabels.get(option.value) || option.name;
      const totalKey = `${page.id}:${option.value}`;
      const expectedTotal = allShops
        ? orderedOptions
            .filter((item) => item.value !== 'all' && item.value !== '')
            .reduce((sum, item) => sum + Number(expectedPageTotals.get(`${page.id}:${item.value}`) || 0), 0)
        : Number(expectedPageTotals.get(totalKey) || 0);
      const state = await selectShop(page, option, expectedShopLabel, expectedTotal);
      if (!allShops && !expectedShopLabels.has(option.value)) {
        expectedShopLabels.set(option.value, state.shopLabels[0]);
      }
      if (!expectedPageTotals.has(totalKey)) expectedPageTotals.set(totalKey, state.total);
      observations.push({
        pageId: page.id,
        pageLabel: page.label,
        round,
        option: { value: option.value, name: option.name },
        ...state,
      });
    }
  }
}

const singleShopLabels = [...expectedShopLabels.values()];
if (new Set(singleShopLabels).size !== singleShopLabels.length) {
  throw new Error(`不同店铺显示成同一个店铺：${JSON.stringify(singleShopLabels)}`);
}

const durations = observations.map((item) => item.durationMs).sort((left, right) => left - right);
const percentile = (ratio) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * ratio) - 1)];
const report = {
  ok: true,
  rounds,
  pageCount: pages.length,
  pages: pages.map(({ id, label }) => ({ id, label })),
  shopCount: expectedShopLabels.size,
  samples: observations.length,
  latencyMs: {
    min: durations[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: durations.at(-1),
  },
  observations,
};

const outputDirectory = path.resolve('test-results');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, 'business-pages-multishop-report.json'),
  JSON.stringify(report, null, 2),
  'utf8'
);
socket.close();
console.log(JSON.stringify(report, null, 2));
