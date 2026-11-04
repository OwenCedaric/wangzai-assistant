import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPurchaseLogisticsSyncService,
  selectExactPurchaseLogisticsAccount,
} from './purchaseLogisticsSyncService.js';

function createHarness({ accounts, pendingOrders, supplierResult, supplierOrderReader, localOverrideRows } = {}) {
  const writes = [];
  const localOverrideWrites = [];
  const localRecordWrites = [];
  const progress = [];
  const tabs = [];
  const commands = [];
  let sequence = 0;
  const service = createPurchaseLogisticsSyncService({
    listAccounts: async () => ({ accounts: accounts || [{
      id: 'purchase-1688-a',
      platformName: '1688',
      platformUrl: 'https://www.1688.com/',
      isDefault: true,
    }] }),
    listPurchaseOverrides: async ({ keyword }) => ({
      rows: localOverrideRows || [{
        shopId: 'shop-a',
        orderKey: `4097603:${keyword}`,
        postingNumber: `4097603:${keyword}`,
        purchaseOrderNumber: keyword,
      }],
    }),
    savePurchaseOverride: async (body) => {
      localOverrideWrites.push(body);
      return { ok: true, override: body };
    },
    saveCrossBorderRecord: async (body) => {
      localRecordWrites.push(body);
      return { ok: true, record: body };
    },
    openSession: async (input) => {
      let tab = tabs.find((candidate) => (
        candidate.accountId === input.accountId && candidate.ownerType === input.ownerType
      ));
      if (!tab) {
        sequence += 1;
        tab = {
          tabId: `tab-${sequence}`,
          accountId: input.accountId,
          ownerType: input.ownerType,
        };
        tabs.push(tab);
      }
      return { tabs: [...tabs], activeTabId: tab.tabId };
    },
    executeCommand: async ({ tabId, command, payload }) => {
      const tab = tabs.find((candidate) => candidate.tabId === tabId);
      commands.push({ tabId, command, payload });
      if (command === 'cross-border-login-status') return { result: { loggedIn: true } };
      if (command === 'cross-border-orders') {
        return { result: { orders: pendingOrders || [
          { orderId: '16880001', packId: 'pack-a', fromName: '1688', orderStatus: '待补物流' },
          { orderId: '16880001', packId: 'pack-b', fromName: '1688', orderStatus: '待补物流' },
        ] } };
      }
      if (command === 'purchase-login-status') {
        assert.ok(tab?.accountId);
        return { result: { loggedIn: true, cookieSaved: true } };
      }
      if (command === 'cross-border-sync' && payload?.mode === 'supplier-order-read') {
        if (typeof supplierOrderReader === 'function') {
          return { result: await supplierOrderReader({ tab, payload }) };
        }
        return { result: {
          ok: true,
          pluginVerified: true,
          purchase: {
            platform: '1688',
            purchaseOrderNumber: payload.order.orderId,
            purchasePrice: 12.34,
            currency: 'CNY',
            purchaseOrderStatus: '待发货',
          },
          logistics: {},
        } };
      }
      if (command === 'cross-border-sync' && payload?.mode === 'supplier-orders-read') {
        const results = await Promise.all((payload.orders || []).map(async (order) => {
          if (typeof supplierOrderReader === 'function') {
            try {
              const result = await supplierOrderReader({ tab, payload: { ...payload, order } });
              return { ...result, order };
            } catch (error) {
              return { ok: false, pluginVerified: true, order, errorCode: error?.code || error?.message };
            }
          }
          return {
            ok: true,
            pluginVerified: true,
            order,
            purchase: {
              platform: '1688',
              purchaseOrderNumber: order.orderId,
              purchasePrice: 12.34,
              currency: 'CNY',
              purchaseOrderStatus: '待发货',
            },
            logistics: {},
          };
        }));
        return { result: { ok: results.every((row) => row.ok), pluginVerified: true, results } };
      }
      if (command === 'cross-border-sync' && payload?.mode === 'supplier-read') {
        return { result: supplierResult || {
          ok: true,
          status: '待同步',
          logistics: { carrier: '中通快递', trackingNumber: `ZT${payload.order.packId}123456` },
        } };
      }
      if (command === 'cross-border-sync' && payload?.mode === 'package-update') {
        writes.push({ order: payload.order, logistics: payload.logistics });
        return { result: {
          ok: true,
          writeAccepted: true,
          readbackVerified: true,
          updateMessage: '更新成功',
        } };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    emitProgress: (value) => progress.push(value),
  });
  return { service, writes, localOverrideWrites, localRecordWrites, progress, commands, tabs };
}

test('同步物流完整链路连续模拟30次，始终按 orderId + packId 精确写回并回读', async () => {
  for (let run = 1; run <= 30; run += 1) {
    const harness = createHarness();
    const result = await harness.service.execute();
    assert.equal(result.ok, true, `run ${run}`);
    assert.equal(result.total, 2, `run ${run}`);
    assert.equal(result.synced, 2, `run ${run}`);
    assert.equal(result.failed, 0, `run ${run}`);
    assert.deepEqual(
      harness.writes.map((entry) => `${entry.order.orderId}:${entry.order.packId}`),
      ['16880001:pack-a', '16880001:pack-b'],
      `run ${run}`,
    );
    assert.equal(harness.progress.at(-1)?.stage, 'completed', `run ${run}`);
    assert.equal(harness.localOverrideWrites.length, 2, `run ${run}`);
    assert.equal(harness.localRecordWrites.length, 2, `run ${run}`);
    assert.ok(harness.localOverrideWrites.every((entry) => entry.domesticCourierCompany === '中通快递'));
    assert.ok(harness.localRecordWrites.every((entry) => entry.domesticLogisticsStatus === '已发货'));
  }
});

test('同平台多账号且无法唯一确定时 fail-closed，不产生任何写回', async () => {
  const harness = createHarness({
    accounts: [
      { id: 'purchase-1688-a', platformName: '1688', platformUrl: 'https://www.1688.com/' },
      { id: 'purchase-1688-b', platformName: '1688', platformUrl: 'https://www.1688.com/' },
    ],
    pendingOrders: [
      { orderId: '16880002', packId: 'pack-c', fromName: '1688', orderStatus: '待补物流' },
    ],
  });
  const result = await harness.service.execute();
  assert.equal(result.synced, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].errorCode, 'CROSS_BORDER_PURCHASE_ACCOUNT_AMBIGUOUS');
  assert.equal(harness.writes.length, 0);
});

test('默认采购账号只能在候选中唯一时选中', () => {
  const selected = selectExactPurchaseLogisticsAccount([
    { id: 'a', platformName: '淘宝' },
    { id: 'b', platformName: '淘宝', isDefault: true },
  ], '淘宝');
  assert.equal(selected.id, 'b');
});

test('同步物流沿用原写回链路，同时携带插件直接读取的实付金额和订单状态', async () => {
  const harness = createHarness({
    pendingOrders: [
      { orderId: '3316981152254029783', packId: 'pack-price', fromName: '1688', orderStatus: '待补物流' },
    ],
    supplierResult: {
      ok: true,
      status: '待同步',
      purchaseInfoComplete: true,
      purchase: {
        platform: '1688',
        purchaseOrderNumber: '3316981152254029783',
        purchasePrice: 5.69,
        currency: 'CNY',
        purchaseOrderStatus: '待发货',
      },
      logistics: { carrier: '中通快递', trackingNumber: 'ZT331698115225' },
    },
  });
  const result = await harness.service.execute();
  assert.equal(result.ok, true);
  assert.equal(result.results[0].purchaseInfoComplete, true);
  assert.equal(result.results[0].purchase.purchasePrice, 5.69);
  assert.equal(result.results[0].purchase.purchaseOrderStatus, '待发货');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.localOverrideWrites[0].domesticTrackingNumber, 'ZT331698115225');
  assert.equal(harness.localRecordWrites[0].carrierName, '中通快递');
  const supplierRead = harness.commands.find((entry) => entry.payload?.mode === 'supplier-read');
  assert.equal(supplierRead.payload.includePurchaseInfo, true);
});

test('批量直读通过同步插件探测隔离账号并按精确单号匹配平台、金额和状态', async () => {
  const accounts = [
    { id: 'purchase-1688-a', platformName: '1688', platformUrl: 'https://www.1688.com/', isDefault: true },
    { id: 'purchase-pdd-a', platformName: '拼多多', platformUrl: 'https://mobile.yangkeduo.com/', isDefault: true },
    { id: 'purchase-taobao-a', platformName: '淘宝', platformUrl: 'https://www.taobao.com/', isDefault: true },
  ];
  const fixtures = new Map([
    ['purchase-pdd-a\u0000260616-423561807492967', { platform: 'pinduoduo', price: 71.3, status: '交易成功' }],
    ['purchase-1688-a\u00003316981152254029783', { platform: '1688', price: 5.69, status: '待发货' }],
    ['purchase-taobao-a\u00003316795501423038965', { platform: 'tmall', price: 50.36, status: '交易成功' }],
  ]);
  const harness = createHarness({
    accounts,
    supplierOrderReader: ({ tab, payload }) => {
      const orderNumber = payload.order.orderId;
      const fixture = fixtures.get(`${tab.accountId}\u0000${orderNumber}`);
      if (!fixture) return { ok: false, pluginVerified: false };
      const requestedPlatform = payload.order.fromName === '天猫'
        ? 'tmall'
        : payload.order.fromName === '淘宝'
          ? 'taobao'
          : payload.order.fromName === '拼多多'
            ? 'pinduoduo'
            : payload.order.fromName;
      const sameAlibabaFamily = ['taobao', 'tmall'].includes(fixture.platform)
        && ['taobao', 'tmall'].includes(requestedPlatform);
      if (fixture.platform !== requestedPlatform && !sameAlibabaFamily) {
        return { ok: false, pluginVerified: false };
      }
      return {
        ok: true,
        directRead: true,
        pluginVerified: true,
        purchase: {
          platform: fixture.platform,
          purchaseOrderNumber: orderNumber,
          purchasePrice: fixture.price,
          currency: 'CNY',
          purchaseOrderStatus: fixture.status,
          sourceMethod: 'supplier-cookie-http-detail',
        },
        logistics: {},
      };
    },
  });
  const result = await harness.service.readOrders({
    orderNumbers: [
      '260616-423561807492967',
      '3316981152254029783',
      '3316795501423038965',
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, 3);
  assert.deepEqual(
    result.results.map((entry) => [entry.platformLabel, entry.purchasePrice, entry.purchaseOrderStatus]),
    [
      ['拼多多', 71.3, '交易成功'],
      ['1688', 5.69, '待发货'],
      ['天猫', 50.36, '交易成功'],
    ],
  );
  assert.ok(result.results.every((entry) => entry.pluginVerified === true));
  assert.ok(result.results.every((entry) => entry.readMethod === 'cross-border-sync-plugin-direct'));
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.commands.some((entry) => entry.command === 'navigate'), false);
  assert.equal(harness.commands.filter((entry) => entry.payload?.mode === 'supplier-order-read').length, 0);
  assert.equal(harness.commands.filter((entry) => entry.payload?.mode === 'supplier-orders-read').length, 3);
});

test('多单直读按账号批量并发，不再逐单逐平台串行等待', async () => {
  const accounts = [
    { id: 'purchase-1688-a', platformName: '1688', platformUrl: 'https://www.1688.com/' },
    { id: 'purchase-pdd-a', platformName: '拼多多', platformUrl: 'https://mobile.yangkeduo.com/' },
    { id: 'purchase-taobao-a', platformName: '淘宝', platformUrl: 'https://www.taobao.com/' },
  ];
  const harness = createHarness({
    accounts,
    supplierOrderReader: async ({ tab, payload }) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const orderNumber = payload.order.orderId;
      const isPdd = orderNumber.includes('-');
      const matches = isPdd
        ? tab.accountId === 'purchase-pdd-a'
        : tab.accountId === 'purchase-taobao-a';
      if (!matches) return { ok: false, pluginVerified: true };
      return {
        ok: true,
        pluginVerified: true,
        purchase: {
          platform: isPdd ? 'pinduoduo' : 'taobao',
          purchaseOrderNumber: orderNumber,
          purchasePrice: 10,
          currency: 'CNY',
          purchaseOrderStatus: '交易成功',
        },
        logistics: {},
      };
    },
  });
  const started = performance.now();
  const result = await harness.service.readOrders({
    orderNumbers: [
      '260613-430440476292967',
      '260611-394663042692967',
      '3301156344300029783',
      '2701710300074029783',
    ],
  });
  const elapsed = performance.now() - started;
  assert.equal(result.matched, 4);
  assert.ok(elapsed < 100, `expected parallel batches below 100ms, got ${elapsed}ms`);
  assert.equal(harness.commands.filter((entry) => entry.payload?.mode === 'supplier-orders-read').length, 3);
});

test('采购单直读只复用插件返回的快递公司和单号并同步到本地共用记录', async () => {
  const harness = createHarness({
    supplierOrderReader: ({ payload }) => ({
      ok: true,
      pluginVerified: true,
      purchase: {
        platform: '1688',
        purchaseOrderNumber: payload.order.orderId,
        purchasePrice: 5.69,
        currency: 'CNY',
        purchaseOrderStatus: '已发货',
      },
      logistics: {
        carrier: '中通快递(ZTO)',
        trackingNumber: '79028134877723',
        sourceMethod: 'cross-border-bus-plugin-original-v1.0.8',
      },
    }),
  });
  const result = await harness.service.readOrders({
    platform: '1688',
    orderNumbers: ['3316981152254029783'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.localFailed, 0);
  assert.equal(result.results[0].localMirror.saved, 1);
  assert.deepEqual(
    {
      carrier: harness.localOverrideWrites[0].domesticCourierCompany,
      trackingNumber: harness.localOverrideWrites[0].domesticTrackingNumber,
      status: harness.localOverrideWrites[0].domesticLogisticsStatus,
      source: harness.localOverrideWrites[0].domesticLogisticsSource,
    },
    {
      carrier: '中通快递(ZTO)',
      trackingNumber: '79028134877723',
      status: '已发货',
      source: 'cross-border-bus-plugin-original-v1.0.8',
    },
  );
  assert.equal(harness.localRecordWrites[0].platformOrder, '3316981152254029783');
});

test('一百条同平台采购单通过一次插件批量命令读取并保持精确顺序', async () => {
  const orderNumbers = Array.from({ length: 100 }, (_, index) => `1688-${String(index + 1).padStart(3, '0')}`);
  const harness = createHarness({
    supplierOrderReader: async ({ payload }) => ({
      ok: true,
      pluginVerified: true,
      purchase: {
        platform: '1688',
        purchaseOrderNumber: payload.order.orderId,
        purchasePrice: 10,
        currency: 'CNY',
        purchaseOrderStatus: '已发货',
      },
      logistics: {},
    }),
  });

  const result = await harness.service.readOrders({ platform: '1688', orderNumbers });

  assert.equal(result.ok, true);
  assert.equal(result.total, 100);
  assert.equal(result.matched, 100);
  assert.deepEqual(result.results.map((row) => row.purchaseOrderNumber), orderNumbers);
  const commands = harness.commands.filter((entry) => entry.payload?.mode === 'supplier-orders-read');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].payload.orders.length, 100);
});
