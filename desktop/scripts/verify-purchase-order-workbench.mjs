const port = Number(process.argv[2] || 9225);
const requestedTarget = String(process.argv[3] || 'https://mobile.yangkeduo.com/').trim();

const PLATFORM_FIXTURES = Object.freeze([
  Object.freeze({ key: '1688', label: '1688', url: 'https://www.1688.com/' }),
  Object.freeze({ key: 'taobao', label: '淘宝', url: 'https://www.taobao.com/' }),
  Object.freeze({ key: 'tmall', label: '天猫', url: 'https://www.tmall.com/' }),
  Object.freeze({ key: 'pinduoduo', label: 'PDD', url: 'https://mobile.yangkeduo.com/' }),
  Object.freeze({ key: 'ozon-buyer', label: 'Ozon买家', url: 'https://www.ozon.ru/' }),
]);

function fixtureForUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return PLATFORM_FIXTURES[3]; }
  if (host === '1688.com' || host.endsWith('.1688.com')) return PLATFORM_FIXTURES[0];
  if (host === 'taobao.com' || host.endsWith('.taobao.com')) return PLATFORM_FIXTURES[1];
  if (host === 'tmall.com' || host.endsWith('.tmall.com')) return PLATFORM_FIXTURES[2];
  if (host === 'yangkeduo.com' || host.endsWith('.yangkeduo.com') || host === 'pinduoduo.com' || host.endsWith('.pinduoduo.com')) return PLATFORM_FIXTURES[3];
  if ((host === 'ozon.ru' || host.endsWith('.ozon.ru')) && host !== 'seller.ozon.ru') return PLATFORM_FIXTURES[4];
  return { key: 'external', label: '其他', url };
}

const targetsToVerify = requestedTarget === '--matrix'
  ? PLATFORM_FIXTURES
  : [{ ...fixtureForUrl(requestedTarget), url: requestedTarget }];

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('app://')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到 Electron CDP 页面：${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let requestId = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(request.timeoutId);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时：${method}`));
    }, 90_000);
    pending.set(id, { resolve, reject, timeoutId });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function workbenchFor(fixture, index) {
  return {
    version: 1,
    kind: 'purchase-order',
    title: '订单操作台',
    order: {
      orderNo: `WORKBENCH-${fixture.key.toUpperCase()}-20260723-${index + 1}`,
      goodsNo: `WB-${fixture.key.toUpperCase()}-001`,
      ozonOrderId: `TEST-OZON-${index + 1}`,
      shop: '测试店铺',
      status: '待拍单',
      salesAmount: '¥99.00',
      purchasePlatform: fixture.label,
      purchaseOrderNo: '待补录',
      ozonStatus: '测试订单',
      paymentTime: '2026/07/23 10:30:00',
    },
    product: {
      title: `${fixture.label}订单操作台测试商品`,
      sku: `WB-SKU-${index + 1}`,
      quantity: 'x1',
      imageUrl: '',
    },
    source: {
      platform: fixture.label,
      amount: fixture.key === 'ozon-buyer' ? '₽1,880' : '¥18.80',
      url: fixture.url,
    },
    logistics: {
      orderId: `TEST-PACKAGE-${index + 1}`,
      weight: '0.35 kg',
      size: '20 x 12 x 8 cm',
      route: '测试物流路线',
      readStatus: '测试数据已就绪',
    },
    profitItems: [
      { label: '销售额', value: '¥99.00' },
      { label: '货源', value: '¥18.80' },
      { label: '平台费', value: '¥20.00' },
      { label: '物流', value: '¥12.00' },
      { label: '利润', value: '+ ¥48.20', tone: 'profit' },
    ],
    notice: '这是本机测试单。左侧信息固定，右侧网页可以正常搜索、跳转和登录。',
  };
}

const results = [];
for (let index = 0; index < targetsToVerify.length; index += 1) {
  const fixture = targetsToVerify[index];
  const workbench = workbenchFor(fixture, index);
  const expression = `window.wangzaiDesktop.purchaseBrowser.command(${JSON.stringify({
    command: 'open-external',
    url: fixture.url,
    workbench,
  })})`;
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'UNKNOWN';
    const error = description.match(/PURCHASE_BROWSER_[A-Z0-9_]+/u)?.[0] || description;
    const configurationRequired = [
      'PURCHASE_BROWSER_EXTERNAL_ACCOUNT_REQUIRED',
      'PURCHASE_BROWSER_OZON_BUYER_ACCOUNT_REQUIRED',
    ].includes(error);
    results.push({
      ok: configurationRequired,
      supported: configurationRequired,
      configured: false,
      opened: false,
      platform: fixture.label,
      targetUrl: fixture.url,
      testOrder: workbench.order.orderNo,
      error,
    });
    continue;
  }
  const browserState = response.result?.value || {};
  const activeTab = Array.isArray(browserState.tabs)
    ? browserState.tabs.find((tab) => tab.tabId === browserState.activeTabId)
    : null;
  results.push({
    ok: true,
    supported: true,
    configured: true,
    opened: true,
    platform: fixture.label,
    testOrder: workbench.order.orderNo,
    targetUrl: fixture.url,
    browserState: {
      engine: browserState.engine,
      phase: browserState.phase,
      health: browserState.health,
      visible: browserState.visible,
      activeUrl: activeTab?.url || '',
      activeTitle: activeTab?.title || '',
    },
  });
}

console.log(JSON.stringify({
  ok: results.every((result) => result.ok),
  mode: requestedTarget === '--matrix' ? 'five-platform-matrix' : 'single-platform',
  results,
}, null, 2));
socket.close();
setTimeout(() => process.exit(0), 100);
