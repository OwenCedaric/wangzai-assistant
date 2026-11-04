import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9223);
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
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
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
    }, 30000);
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

async function waitFor(expression, timeoutMs = 15000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待页面状态超时：${expression}`);
}

async function clickByText(label) {
  const clicked = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const candidates = Array.from(document.querySelectorAll('[role="button"], button'));
    const target = candidates.find((element) => element.innerText?.trim() === label)
      || candidates.find((element) => element.innerText?.trim().startsWith(label + '\\n'))
      || candidates
        .filter((element) => element.innerText?.includes(label))
        .sort((left, right) => left.innerText.length - right.innerText.length)[0];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到可点击入口：${label}`);
}

async function clickTab(label) {
  const clicked = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const target = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((element) => element.innerText?.trim() === label);
    if (!target) return false;
    target.scrollIntoView({ block: 'nearest', inline: 'center' });
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到数据分析模块标签：${label}`);
}

async function assertText(text, timeoutMs = 15000) {
  await waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs);
}

async function assertMainText(text, timeoutMs = 15000) {
  await waitFor(
    `document.querySelector('[data-testid="data-analysis-main"]')?.innerText.includes(${JSON.stringify(text)})`,
    timeoutMs,
  );
}

async function assertMainNotText(texts) {
  const found = await evaluate(`(() => {
    const text = document.querySelector('[data-testid="data-analysis-main"]')?.innerText || '';
    return ${JSON.stringify(texts)}.filter((item) => text.includes(item));
  })()`);
  if (found.length) throw new Error(`经营主画布仍包含技术信息：${found.join('、')}`);
}

async function assertHealthyPage() {
  const result = await evaluate(`({
    hasErrorBoundary: document.body.innerText.includes('页面显示异常'),
    hasNaN: /(^|\\s)NaN($|\\s)/.test(document.body.innerText),
    hasUndefined: /(^|\\s)undefined($|\\s)/.test(document.body.innerText),
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    pageWidth: document.querySelector('.data-analysis-page')?.scrollWidth || 0,
    pageClientWidth: document.querySelector('.data-analysis-page')?.clientWidth || 0,
    tabScrollWidth: document.querySelector('[role="tablist"]')?.scrollWidth || 0,
    tabClientWidth: document.querySelector('[role="tablist"]')?.clientWidth || 0,
    cardBorders: Array.from(document.querySelectorAll('[data-testid="data-analysis-main"] .MuiCard-root:not(.data-analysis-toolbar-card)'))
      .map((node) => getComputedStyle(node).borderTopWidth),
    metricBorders: Array.from(document.querySelectorAll('[data-testid="overview-kpi-card"]'))
      .map((node) => getComputedStyle(node).borderTopWidth),
  })`);
  if (result.hasErrorBoundary || result.hasNaN || result.hasUndefined) {
    throw new Error(`页面健康检查失败：${JSON.stringify(result)}`);
  }
  if (result.bodyWidth > result.viewportWidth + 2) {
    throw new Error(`页面出现整体横向溢出：${JSON.stringify(result)}`);
  }
  if (result.pageWidth > result.pageClientWidth + 2) {
    throw new Error(`数据分析主画布出现横向溢出：${JSON.stringify(result)}`);
  }
  if ([...result.cardBorders, ...result.metricBorders].some((width) => width !== '0px')) {
    throw new Error(`数据分析核心卡片仍存在描边：${JSON.stringify(result)}`);
  }
  return result;
}

async function assertToolbarLayout() {
  const result = await evaluate(`(() => {
    const toolbar = document.querySelector('[aria-label="数据筛选条件"]');
    const layout = toolbar?.querySelector('.data-analysis-toolbar-layout');
    const fields = Array.from(toolbar?.querySelectorAll('.data-analysis-toolbar-field') || []);
    const sync = toolbar?.querySelector('.data-analysis-toolbar-sync');
    if (!toolbar || !layout || fields.length !== 3 || !sync) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const children = [...fields, sync].map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    return {
      toolbar: { left: toolbarRect.left, right: toolbarRect.right, width: toolbarRect.width, height: toolbarRect.height },
      children,
      labels: Array.from(toolbar.querySelectorAll('.data-analysis-toolbar-label')).map((node) => node.textContent.trim()),
      overflow: layout.scrollWidth - layout.clientWidth,
    };
  })()`);
  if (!result) throw new Error('数据筛选栏结构不完整');
  if (result.overflow > 2) throw new Error(`数据筛选栏出现横向溢出：${JSON.stringify(result)}`);
  if (JSON.stringify(result.labels) !== JSON.stringify(['店铺范围', '统计周期', '日期范围'])) {
    throw new Error(`数据筛选栏标签不完整：${JSON.stringify(result)}`);
  }
  if (result.children.some((item) => item.left < result.toolbar.left - 1 || item.right > result.toolbar.right + 1 || item.height < 20)) {
    throw new Error(`数据筛选栏控件越界或高度不足：${JSON.stringify(result)}`);
  }
  return result;
}

async function assertKpiHoverStability() {
  const before = await evaluate(`(() => {
    const node = document.querySelector('[data-testid="overview-kpi-card"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      transform: style.transform,
      transition: style.transitionProperty,
    };
  })()`);
  if (!before) throw new Error('没有找到用于悬停稳定性验证的核心指标卡');
  if (before.transform !== 'none' || before.transition.includes('transform')) {
    throw new Error(`核心指标卡存在位移式悬停配置：${JSON.stringify(before)}`);
  }

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
  await new Promise((resolve) => setTimeout(resolve, 220));
  const after = await evaluate(`(() => {
    const node = document.querySelector('[data-testid="overview-kpi-card"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      transform: getComputedStyle(node).transform,
    };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  if (!after) throw new Error('悬停后核心指标卡消失');
  const moved = ['left', 'top', 'width', 'height'].some((key) => Math.abs(after[key] - before[key]) > 0.5);
  if (moved || after.transform !== 'none') {
    throw new Error(`核心指标卡悬停后发生位移或缩放：${JSON.stringify({ before, after })}`);
  }
  return { before, after };
}

async function assertOverviewGridAlignment() {
  const rows = await evaluate(`(() => {
    const readRect = (label) => {
      const node = document.querySelector('[aria-label="' + label + '"]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      funnel: readRect('流量转化漏斗'),
      diagnostics: readRect('经营提醒'),
      trend: readRect('销售与订单趋势'),
      ranking: readRect('热销商品'),
    };
  })()`);
  if (Object.values(rows).some((item) => !item)) {
    throw new Error(`经营总览缺少用于对齐校验的面板：${JSON.stringify(rows)}`);
  }
  const differences = {
    firstRowBottom: Math.abs(rows.funnel.bottom - rows.diagnostics.bottom),
    secondRowBottom: Math.abs(rows.trend.bottom - rows.ranking.bottom),
    firstRowTop: Math.abs(rows.funnel.top - rows.diagnostics.top),
    secondRowTop: Math.abs(rows.trend.top - rows.ranking.top),
  };
  if (Object.values(differences).some((value) => value > 0.5)) {
    throw new Error(`经营总览双栏面板底部或顶部未对齐：${JSON.stringify({ rows, differences })}`);
  }
  return { rows, differences };
}

async function assertModuleBottomAlignment(moduleLabel, expectedText, panelLabels) {
  await clickTab(moduleLabel);
  await assertMainText(expectedText);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const panels = await evaluate(`(() => {
    const readRect = (label) => {
      const node = document.querySelector('[aria-label="' + label + '"]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return Object.fromEntries(${JSON.stringify(panelLabels)}.map((label) => [label, readRect(label)]));
  })()`);
  if (Object.values(panels).some((panel) => !panel)) {
    throw new Error(`${moduleLabel}缺少用于底部对齐校验的面板：${JSON.stringify(panels)}`);
  }
  if (Object.values(panels).some((panel) => panel.height < 120)) {
    throw new Error(`${moduleLabel}存在被压缩的双栏面板：${JSON.stringify(panels)}`);
  }
  const bottoms = Object.values(panels).map((panel) => panel.bottom);
  const difference = Math.max(...bottoms) - Math.min(...bottoms);
  if (difference > 0.5) {
    throw new Error(`${moduleLabel}双栏面板底部未对齐：${JSON.stringify({ panels, difference })}`);
  }
  return { panels, difference };
}

async function capture(name) {
  let result = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!result?.data) throw lastError || new Error(`页面截图失败：${name}`);
  const outputDirectory = path.resolve('test-results');
  await mkdir(outputDirectory, { recursive: true });
  const filePath = path.join(outputDirectory, name);
  await writeFile(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

await send('Page.enable');
await send('Runtime.enable');

await send('Emulation.setDeviceMetricsOverride', {
  width: 1427,
  height: 859,
  deviceScaleFactor: 1,
  mobile: false,
});

await clickByText('数据分析');
await assertMainText('数据分析');
await clickTab('总览');
await assertMainText('销售与订单趋势');
await assertMainText('流量转化漏斗');
await assertMainText('经营提醒');
await assertMainText('热销商品');
await waitFor(`document.querySelectorAll('[role="tab"]').length === 10`);
const overviewMetrics = await evaluate(`Array.from(
  document.querySelectorAll('[data-testid="data-analysis-main"] [data-testid="overview-kpi-card"]')
).map((node) => ({ id: node.dataset.metricId, text: node.innerText }))`);
const expectedMetricIds = [
  'trafficSessionCount',
  'trafficOrderCount',
  'trafficOrderConversionRate',
  'salesAmount',
  'financeNetAmount',
  'outOfStockCount',
];
if (JSON.stringify(overviewMetrics.map((item) => item.id)) !== JSON.stringify(expectedMetricIds)) {
  throw new Error(`经营总览核心指标不符合预期：${JSON.stringify(overviewMetrics)}`);
}
if (overviewMetrics.some((item) => !item.text || /NaN|undefined/.test(item.text))) {
  throw new Error(`经营总览核心指标存在无效值：${JSON.stringify(overviewMetrics)}`);
}
const forbiddenMainTerms = [
  '数据源台账', 'SQLite已就绪', '个端点', '数据规则', '未进入SQLite', 'SQLite',
  'Performance API', 'Ozon原因ID', 'is_defect=true', 'operation_type', 'return_reason',
  'visibility', 'fulfillment/source', 'quantity', 'amount', 'ACOS', 'ROAS', 'CTR', 'CPC',
];
await assertMainNotText(forbiddenMainTerms);
await waitFor(`Boolean(document.querySelector('.apexcharts-canvas'))`);
await new Promise((resolve) => setTimeout(resolve, 1200));
const overviewHealth = await assertHealthyPage();
const toolbarLayout = await assertToolbarLayout();
const hoverStability = await assertKpiHoverStability();
const overviewAlignment = await assertOverviewGridAlignment();
const overviewScreenshot = await capture('data-analysis-overview-1427.png');

const productBottomAlignment = await assertModuleBottomAlignment('商品', '商品数据完整度', ['价格带分布', '类目覆盖']);
const productAlignmentScreenshot = await capture('data-analysis-products-aligned.png');
const profitBottomAlignment = await assertModuleBottomAlignment('利润', '费用结构', ['费用结构', '主要扣减流水']);
const profitAlignmentScreenshot = await capture('data-analysis-profit-aligned.png');
const inventoryBottomAlignment = await assertModuleBottomAlignment('库存', '缺货与低库存商品', ['缺货与低库存商品', '商品数据完整度']);
const inventoryAlignmentScreenshot = await capture('data-analysis-inventory-aligned.png');
const afterSalesBottomAlignment = await assertModuleBottomAlignment('售后', '售后原因分布', ['售后状态分布', '售后原因分布']);
const afterSalesAlignmentScreenshot = await capture('data-analysis-after-sales-aligned.png');
const pairedBottomAlignment = {
  商品: productBottomAlignment,
  利润: profitBottomAlignment,
  库存: inventoryBottomAlignment,
  售后: afterSalesBottomAlignment,
};

const moduleChecks = [
  ['销售', '订单状态分布', 'sales'],
  ['商品', '商品数据完整度', 'products'],
  ['流量', '流量与转化趋势', 'traffic'],
  ['广告', '广告', 'advertising'],
  ['利润', '费用结构', 'profit'],
  ['库存', '缺货与低库存商品', 'inventory'],
  ['售后', '售后原因分布', 'after-sales'],
  ['促销', '促销活动', 'marketing'],
    ['市场', '平台 市场分析', 'market'],
];
const moduleScreenshots = [];

for (const [moduleLabel, expectedText, screenshotId] of moduleChecks) {
  await clickTab(moduleLabel);
  if (moduleLabel === '流量') {
    const trafficMissing = await evaluate(`document.querySelector('[data-testid="data-analysis-main"]')?.innerText.includes('还没有官方流量快照')`);
    if (trafficMissing) {
      await assertMainText('还没有官方流量快照');
    } else {
      await assertMainText(expectedText);
    }
  } else {
    await assertMainText(expectedText);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assertMainNotText(forbiddenMainTerms);
  await assertHealthyPage();
  moduleScreenshots.push(await capture(`data-analysis-module-${screenshotId}.png`));
}

await clickTab('广告');
await waitFor(
  `['广告投放概况','广告官方数据读取失败','需要配置广告接口','正在读取官方广告统计'].some((text) => document.body.innerText.includes(text))`,
  20000,
  500
);
const advertisingState = await evaluate(`({
  success: document.body.innerText.includes('广告投放概况'),
  loading: document.body.innerText.includes('正在读取官方广告统计'),
  statisticsUnavailable: document.body.innerText.includes('统计阶段没有成功返回'),
  failure: document.body.innerText.includes('广告官方数据读取失败'),
  authorizationRequired: document.body.innerText.includes('需要配置广告接口'),
})`);
if (advertisingState.failure) {
  throw new Error(`广告模块未完成真实读取：${JSON.stringify(advertisingState)}`);
}
await assertHealthyPage();

await clickTab('总览');
await assertMainText('销售与订单趋势');
await assertMainText('流量转化漏斗');
await clickByText('数据说明');
await waitFor(`Boolean(document.querySelector('[role="dialog"][aria-label="数据说明"]'))`);
await assertText('指标口径与规则');
await assertText('数据来源');
const infoHealth = await assertHealthyPage();
const infoScreenshot = await capture('data-analysis-data-info.png');
const closed = await evaluate(`(() => {
  const button = document.querySelector('[aria-label="关闭数据说明"]');
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!closed) throw new Error('数据说明抽屉没有可用的关闭按钮');
await waitFor(`!document.querySelector('[role="dialog"][aria-label="数据说明"]')`);
await assertMainNotText(forbiddenMainTerms);

await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await clickTab('总览');
await assertMainText('销售与订单趋势');
await assertMainText('流量转化漏斗');
const compactHealth = await assertHealthyPage();
const compactToolbarLayout = await assertToolbarLayout();
const compactScreenshot = await capture('data-analysis-overview-1280.png');

await send('Emulation.setDeviceMetricsOverride', {
  width: 1024,
  height: 768,
  deviceScaleFactor: 1,
  mobile: false,
});
await clickTab('总览');
await assertMainText('销售与订单趋势');
await assertMainText('流量转化漏斗');
const narrowHealth = await assertHealthyPage();
const narrowToolbarLayout = await assertToolbarLayout();
for (const [moduleLabel, expectedText] of moduleChecks) {
  await clickTab(moduleLabel);
  if (moduleLabel === '流量') {
    const trafficMissing = await evaluate(`document.querySelector('[data-testid="data-analysis-main"]')?.innerText.includes('还没有官方流量快照')`);
    await assertMainText(trafficMissing ? '还没有官方流量快照' : expectedText);
  } else {
    await assertMainText(expectedText);
  }
  await assertMainNotText(forbiddenMainTerms);
  await assertHealthyPage();
}
await clickTab('总览');
const narrowScreenshot = await capture('data-analysis-overview-1024.png');
await send('Emulation.clearDeviceMetricsOverride');

const summary = await evaluate(`({
  title: document.querySelector('.data-analysis-page h1, .data-analysis-page h2, .data-analysis-page h3, .data-analysis-page h4')?.innerText || '',
  metrics: Array.from(document.querySelectorAll('.data-analysis-page')).flatMap((root) =>
    Array.from(root.querySelectorAll('div')).filter((node) => ['订单数','订单销售额','在售缺货','售后单数'].includes(node.innerText?.trim())).map((node) => node.innerText.trim())
  ),
  bodyTextSample: document.querySelector('.data-analysis-page')?.innerText.slice(0, 1600) || '',
})`);

console.log(
  JSON.stringify(
    {
      ok: true,
      overviewHealth,
      toolbarLayout,
      compactHealth,
      narrowHealth,
      compactToolbarLayout,
      narrowToolbarLayout,
      infoHealth,
  hoverStability,
  overviewAlignment,
  pairedBottomAlignment,
      advertisingState,
      screenshots: [
        overviewScreenshot,
        productAlignmentScreenshot,
        profitAlignmentScreenshot,
        inventoryAlignmentScreenshot,
        afterSalesAlignmentScreenshot,
        ...moduleScreenshots,
        compactScreenshot,
        narrowScreenshot,
        infoScreenshot,
      ],
      summary,
    },
    null,
    2
  )
);
socket.close();
setTimeout(() => process.exit(0), 100);
