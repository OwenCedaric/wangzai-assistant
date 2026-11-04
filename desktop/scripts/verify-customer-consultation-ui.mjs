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
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
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

async function clickByAria(label) {
  const clicked = await evaluate(`(() => {
    const target = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`没有找到导航栏操作：${label}`);
}

async function setSidebarOpen(open) {
  const currentlyOpen = await evaluate(`document.querySelector('.main-shell')?.classList.contains('sidebar-open') === true`);
  if (currentlyOpen === open) return;
  await clickByAria(open ? '展开导航栏' : '收起导航栏');
  await waitFor(`document.querySelector('.main-shell')?.classList.contains('sidebar-open') === ${open}`);
  await new Promise((resolve) => setTimeout(resolve, 380));
}

async function inspectSidebarFill(name) {
  const result = await evaluate(`(() => {
    const readRect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      name: ${JSON.stringify(name)},
      sidebarOpen: document.querySelector('.main-shell')?.classList.contains('sidebar-open') === true,
      zoom: getComputedStyle(document.querySelector('.workspace-scale-surface')).zoom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      main: readRect('.main-shell'),
      workspace: readRect('.customer-consultation-workspace'),
      layout: readRect('.customer-chat-layout'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      overflowY: document.documentElement.scrollHeight > window.innerHeight + 2,
    };
  })()`);
  if (Math.abs(Number.parseFloat(result.zoom) - 1) > 0.01) {
    throw new Error(`客服页仍受全局缩放影响：${JSON.stringify(result)}`);
  }
  if (!result.main || !result.workspace || !result.layout) {
    throw new Error(`客服页缺少布局容器：${JSON.stringify(result)}`);
  }
  if (Math.abs(result.workspace.bottom - result.viewportHeight) > 1.5 || result.overflowX || result.overflowY) {
    throw new Error(`客服页在${name}状态未贴齐底部或发生溢出：${JSON.stringify(result)}`);
  }
  if (result.layout.width > result.main.width + 1.5 || result.layout.height > result.workspace.height + 1.5) {
    throw new Error(`客服三栏在${name}状态发生变形或越界：${JSON.stringify(result)}`);
  }
  return result;
}

async function inspectNonCustomerLayout() {
  await clickByText('旺崽汇总');
  await waitFor(`!document.querySelector('.page-panel:not([hidden]) .customer-consultation-page')`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await evaluate(`(() => {
    const surface = document.querySelector('.workspace-scale-surface');
    const content = document.querySelector('.content-shell');
    const rect = surface?.getBoundingClientRect();
    return {
      hasActiveCustomer: Boolean(document.querySelector('.page-panel:not([hidden]) .customer-consultation-page')),
      zoom: surface ? Number.parseFloat(getComputedStyle(surface).zoom) : null,
      contentPadding: content ? getComputedStyle(content).padding : '',
      surfaceRight: rect?.right || 0,
      viewportWidth: window.innerWidth,
    };
  })()`);
  if (
    result.hasActiveCustomer
    || result.zoom === null
    || result.zoom >= 0.99
    || result.contentPadding === '0px'
    || result.surfaceRight > result.viewportWidth + 2
  ) {
    throw new Error(`客服专用布局仍泄漏到普通页面：${JSON.stringify(result)}`);
  }
  return result;
}

async function capture(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
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

await setSidebarOpen(true);
await clickByText('客服咨询');
await waitFor(`Boolean(document.querySelector('.customer-consultation-page'))`);
await waitFor(`Boolean(document.querySelector('.customer-consultation-workspace'))`);
await waitFor(`Boolean(document.querySelector('[aria-label="Ozon 会话列表"]'))`);
await waitFor(
  `Boolean(document.querySelector('.customer-chat-list-item')) || Boolean(document.querySelector('.customer-chat-list-empty'))`,
  20000,
);

const beforeFilter = await evaluate(`(() => ({
  activeFilter: document.querySelector('.customer-chat-filter.active')?.innerText?.trim() || '',
  filters: Array.from(document.querySelectorAll('.customer-chat-filter')).map((node) => node.innerText.trim()),
  searchPlaceholder: document.querySelector('.customer-chat-list-head input')?.placeholder || '',
  hasReadAction: Boolean(document.querySelector('[aria-label="全部标记为已读"]')),
  hasSyncAction: Boolean(document.querySelector('[aria-label="同步 Ozon 会话"]')),
  hasMainPanel: Boolean(document.querySelector('.customer-chat-main-panel')),
  hasSidePanel: Boolean(document.querySelector('.customer-chat-context-panel')),
  hasEmptyThread: Boolean(document.querySelector('.customer-chat-thread-empty')),
  hasConversation: Boolean(document.querySelector('.customer-chat-list-item')),
  pageHeight: Number.parseFloat(getComputedStyle(document.querySelector('.customer-consultation-page')).height),
  pageExpectedHeight: window.innerHeight - 78,
  shellPadding: getComputedStyle(document.querySelector('.content-shell')).padding,
  listTitleFontSize: getComputedStyle(document.querySelector('.customer-chat-list-title-row .MuiTypography-h6')).fontSize,
  searchHeight: getComputedStyle(document.querySelector('.customer-chat-list-head .MuiOutlinedInput-root')).height,
  listItemMinHeight: document.querySelector('.customer-chat-list-item')
    ? getComputedStyle(document.querySelector('.customer-chat-list-item')).minHeight
    : '',
  messageFontSize: document.querySelector('.customer-chat-bubble .MuiTypography-body2')
    ? getComputedStyle(document.querySelector('.customer-chat-bubble .MuiTypography-body2')).fontSize
    : '',
  composerMinHeight: getComputedStyle(document.querySelector('.customer-message-composer .MuiOutlinedInput-root')).minHeight,
  layoutColumns: getComputedStyle(document.querySelector('.customer-chat-layout')).gridTemplateColumns,
  bodyHeight: document.documentElement.scrollHeight,
  viewportHeight: window.innerHeight,
  bodyWidth: document.documentElement.scrollWidth,
  viewportWidth: window.innerWidth,
  hasErrorBoundary: document.body.innerText.includes('页面显示异常'),
  hasNaN: /(^|\\s)NaN($|\\s)/.test(document.body.innerText),
  hasUndefined: /(^|\\s)undefined($|\\s)/.test(document.body.innerText),
}))()`);

const expectedFilters = ['全部', '买家咨询', '未读', 'Ozon 通知', '平台支持'];
if (JSON.stringify(beforeFilter.filters) !== JSON.stringify(expectedFilters)) {
  throw new Error(`客服会话筛选不完整：${JSON.stringify(beforeFilter)}`);
}
if (
  !beforeFilter.hasReadAction
  || !beforeFilter.hasSyncAction
  || !beforeFilter.hasMainPanel
  || (!beforeFilter.hasSidePanel && !beforeFilter.hasEmptyThread)
) {
  throw new Error(`客服咨询关键区域或只读操作入口缺失：${JSON.stringify(beforeFilter)}`);
}
if (!beforeFilter.searchPlaceholder.includes('买家、订单或 SKU')) {
  throw new Error(`客服咨询搜索输入不符合预期：${JSON.stringify(beforeFilter)}`);
}
if (beforeFilter.hasErrorBoundary || beforeFilter.hasNaN || beforeFilter.hasUndefined) {
  throw new Error(`客服咨询页面健康检查失败：${JSON.stringify(beforeFilter)}`);
}
if (beforeFilter.bodyWidth > beforeFilter.viewportWidth + 2 || beforeFilter.bodyHeight > beforeFilter.viewportHeight + 2) {
  throw new Error(`客服咨询出现外层溢出：${JSON.stringify(beforeFilter)}`);
}
if (Math.abs(beforeFilter.pageHeight - beforeFilter.pageExpectedHeight) > 1 || beforeFilter.shellPadding !== '0px') {
  throw new Error(`客服咨询工作区未铺满当前内容高度：${JSON.stringify(beforeFilter)}`);
}
if (beforeFilter.hasConversation && (
  beforeFilter.listTitleFontSize !== '21px'
  || Math.abs(Number.parseFloat(beforeFilter.searchHeight) - 44) > 0.1
  || beforeFilter.listItemMinHeight !== '92px'
  || beforeFilter.messageFontSize !== '17px'
  || beforeFilter.composerMinHeight !== '168px'
)) {
  throw new Error(`客服咨询字号或输入框体未按清晰度规范放大：${JSON.stringify(beforeFilter)}`);
}

await clickByText('买家咨询');
await waitFor(`document.querySelector('.customer-chat-filter.active')?.innerText?.trim() === '买家咨询'`);
await clickByText('全部');
await waitFor(`document.querySelector('.customer-chat-filter.active')?.innerText?.trim() === '全部'`);

const sidebarOpenLayout = await inspectSidebarFill('导航栏展开');
await setSidebarOpen(false);
const sidebarCollapsedLayout = await inspectSidebarFill('导航栏收起');
await setSidebarOpen(true);
const sidebarRestoredLayout = await inspectSidebarFill('导航栏再次展开');
const nonCustomerLayout = await inspectNonCustomerLayout();
await clickByText('客服咨询');
await waitFor(`Boolean(document.querySelector('.page-panel:not([hidden]) .customer-consultation-page'))`);
await new Promise((resolve) => setTimeout(resolve, 500));
const customerReturnLayout = await inspectSidebarFill('普通页面回切客服');
const screenshot = await capture('customer-consultation-1427.png');
console.log(JSON.stringify({ beforeFilter, sidebarOpenLayout, sidebarCollapsedLayout, sidebarRestoredLayout, nonCustomerLayout, customerReturnLayout, screenshot }, null, 2));
socket.close();
