import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import CssBaseline from '@mui/material/CssBaseline';
import Stack from '@mui/material/Stack';
import { ThemeProvider } from '@mui/material/styles';
import App from '../App.jsx';
import { MinimizedTaskProvider, useMinimizedTasks } from '../shared/ui/minimizedTasks/MinimizedTaskProvider.jsx';
import { appTheme } from '../theme.js';
import { useMarketingCardsState } from '../features/marketing/model/useMarketingCardsState.jsx';

vi.mock('../shared/ui/CommunityChart.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: function MockCommunityChart() {
      return ReactModule.default.createElement('div', { 'data-testid': 'apex-chart' });
    },
  };
});

vi.mock('../services/logisticsPricingService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    calculateLogisticsFreight(input = {}) {
      if (!input.routeId) {
        return {
          ok: false,
          ambiguous: true,
          candidates: [
            { routeId: 'route-fixture-a', providerId: 'cdek', routeLabel: '云测标准线路 A', amount: 12.5 },
            { routeId: 'route-fixture-b', providerId: 'cdek', routeLabel: '云测标准线路 B', amount: 13.5 },
          ],
        };
      }
      return {
        ok: true,
        ambiguous: false,
        candidates: [],
        providerLabel: '云测物流',
        routeLabel: input.routeId,
        amount: 12.5,
        display: '¥12.50',
        actualWeight: 0.5,
        volumeWeight: 0.5,
        chargeWeight: 0.5,
        kgFee: 10,
        ticketFee: 7.5,
        market: input.market || 'RU',
        matchedBy: '云测线路',
      };
    },
  };
});

vi.mock('../entities/product/productOzonApi.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    requestOzonWarehouseConfigSnapshot: vi.fn(async () => ({
      status: 'success',
      warehouses: [{ id: 'warehouse-fixture', rawId: 'warehouse-fixture', name: '云测仓库', status: 'active', address: '云测地址' }],
      deliveryMethods: [{ id: 'method-fixture', rawId: 'method-fixture', warehouseId: 'warehouse-fixture', name: '云测配送方式', status: 'active' }],
      fetchedAt: '2026-08-20T00:00:00.000Z',
      error: '',
      warnings: [],
    })),
    requestOzonWarehouseProductsSnapshot: vi.fn(async () => ({
      status: 'success',
      rows: [{ ...fixtureRow, id: 'product-fixture', productId: 'product-fixture', offerId: 'offer-fixture', warehouseId: 'warehouse-fixture', warehouseIds: ['warehouse-fixture'] }],
      total: 1,
      fetchedAt: '2026-08-20T00:00:00.000Z',
      error: '',
      warnings: [],
    })),
  };
});

vi.mock('../features/settings/services/ozonBrowserLoginService.js', () => ({
  openOzonBrowserLogin: vi.fn(async () => ({ tab: { tabId: 'ozon-login-fixture' } })),
  hideOzonBrowserLogin: vi.fn(async () => ({ ok: true })),
  waitForOzonBrowserLogin: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../features/settings/services/ozonBrowserDataService.js', () => ({
  waitForOzonBrowserDataObserver: vi.fn(async () => ({ result: { extensionVersion: '2.0.0' } })),
}));

vi.mock('../entities/profit/profitAfterSalesSnapshot.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    requestOzonAfterSalesSnapshotForShops: vi.fn(async (shops = []) => ({
      rows: [fixtureOrder],
      ruleVersion: 'v2-cloud-fixture',
      errors: [],
      classificationEvidence: { attempted: 0, pending: 0, failed: 0 },
      shops: shops.map((shop) => ({ id: shop.id, clientId: shop.clientId, label: shop.shopAlias || shop.name })),
      fetchedAt: '2026-08-20T00:00:00.000Z',
    })),
  };
});

vi.mock('../features/followSellerDefense/model/useFollowSellerDefense.js', async () => {
  const ReactModule = await import('react');
  const cases = [
    {
      id: 'follow-case-detected', shopId: 'ozon-shop-1', productId: 'product-fixture', productName: '云测商品',
      offerId: 'offer-detected', sku: 'sku-detected', status: 'detected', followCountBefore: 1,
    },
    {
      id: 'follow-case-preview', shopId: 'ozon-shop-1', productId: 'product-fixture', productName: '云测商品',
      offerId: 'offer-preview', sku: 'sku-preview', status: 'preview_ready', followCountBefore: 1, previewId: 'preview-fixture',
      writePayload: {
        workflow: 'ozon-seller-backend-content-complaint-v2', submissionReady: true,
        originalSku: 'sku-preview', followerSkus: ['follower-sku-fixture'],
        sellers: [{ sku: 'follower-sku-fixture', sellerName: '云测跟卖商家' }],
        evidence: { files: [{ name: 'evidence.pdf', path: 'C:/fixture/evidence.pdf' }] },
        route: ['商品和价格', '质量监督', '卖家使用我的内容'],
      },
    },
    {
      id: 'follow-case-verification', shopId: 'ozon-shop-1', productId: 'product-fixture', productName: '云测商品',
      offerId: 'offer-verification', sku: 'sku-verification', status: 'verification_ready', followCountBefore: 1,
    },
    {
      id: 'follow-case-continue', shopId: 'ozon-shop-1', productId: 'product-fixture', productName: '云测商品',
      offerId: 'offer-continue', sku: 'sku-continue', status: 'submission_failed', followCountBefore: 1,
      writeResult: { ticketId: 'ticket-fixture' }, writePayload: { workflow: 'ozon-seller-backend-content-complaint-v2' },
    },
    {
      id: 'follow-case-capture-failed', shopId: 'ozon-shop-1', productId: 'product-fixture', productName: '云测商品',
      offerId: 'offer-capture-failed', sku: 'sku-capture-failed', status: 'capture_failed', lastErrorCode: 'NETWORK_ERROR',
    },
  ];
  const completed = async () => ({ ok: true, cases, updatedCases: cases });
  return {
    useFollowSellerDefense() {
      const [busyAction, setBusyAction] = ReactModule.useState('');
      const [scheme1BrowserAvailable, setScheme1BrowserAvailable] = ReactModule.useState(false);
      const scanShop = async () => {
        setBusyAction('scanning');
        await new Promise(() => {});
      };
      const runScheme1 = async () => {
        setScheme1BrowserAvailable(true);
        return { ok: true };
      };
      return {
        busyAction,
        error: '',
        notice: '',
        loginProfiles: [{ id: 'follow-login-fixture', platformName: 'Ozon 前台巡查云测账号', connected: true }],
        selectedLoginProfileId: 'follow-login-fixture',
        loginReady: true,
        currentCases: cases,
        currentPatrol: { id: 'patrol-fixture', failedCount: 1 },
        overview: { cases, patrols: [{ id: 'patrol-fixture', failedCount: 1 }], counts: { total: cases.length } },
        retryCaptureCount: 1,
        progress: { done: 1, total: cases.length, failed: 1 },
        scheme1Progress: [{ id: 'progress-fixture', stage: 'browser-ready', status: 'running', message: '云测浏览器已就绪' }],
        scheme1BrowserAvailable,
        scheme1BrowserOpening: false,
        refresh: completed,
        refreshLoginProfiles: completed,
        chooseLoginProfile: completed,
        createLoginProfile: completed,
        openLoginProfile: completed,
        clearFeedback: () => {},
        scanManual: completed,
        scanShop,
        retryFailedCaptures: completed,
        cancelScan: () => { setBusyAction(''); return true; },
        prepare: completed,
        confirm: completed,
        runScheme2: completed,
        runScheme1,
        showScheme1Browser: completed,
        verify: completed,
        resume: completed,
        continueScheme1: completed,
      };
    },
  };
});

const pages = [
  '旺崽汇总', '商品列表', '剔除跟卖', '销售订单', '售后订单', '拍单管理', '仓储物流',
  '营销活动', '付费推广', '利润核算', '数据分析', '在线客服', '智能回复', '智能工具', '采集核价',
  '积分套餐', '数据备份',
];
const passed = new Map();
const failures = [];
const stubCalls = [];
let licenseRenewalCoverage = false;
let consoleErrorSpy;
let consoleLogSpy;
let consoleWarnSpy;
let currentCrawlPageLabel = '';
const progressEnabled = process.env.WANGZAI_V2_UI_COVERAGE_PROGRESS === '1';
const componentFilter = String(process.env.WANGZAI_V2_UI_COMPONENT_FILTER || '').trim();
const componentVariantFilter = String(process.env.WANGZAI_V2_UI_COMPONENT_VARIANT || '').trim();
const skipAppCrawler = process.env.WANGZAI_V2_UI_SKIP_APP === '1';
const inventoryModulePaths = (() => {
  try {
    const inventoryPath = path.resolve(process.cwd(), '..', 'artifacts', 'v2-ui-inventory', 'inventory.json');
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8').replace(/^\uFEFF/u, ''));
    return new Set((inventory.controls || []).map((item) => String(item.file || '')
      .replace(/^frontend\/src\//u, '../')
      .replaceAll('\\', '/')));
  } catch {
    return new Set();
  }
})();
const componentModules = {
  ...import.meta.glob([
    '../features/**/*.jsx',
    '../app/**/*.jsx',
    '../shared/ui/minimizedTasks/MinimizedTaskBar.jsx',
    '!../features/**/*.test.jsx',
    '!../features/**/*.spec.jsx',
    '!../app/**/*.test.jsx',
    '!../app/**/*.spec.jsx',
  ], { eager: true }),
};

const COMPONENT_EXPORT_SUFFIX = /(?:Page|View|Dialog|Dialogs|Panel|Card|Workspace|Steps|Step|State|Popover|Header|Toolbar|Run|Editor|List|Rows|Row|Thread|Composer|Actions|Controls|Picker|Selector|Report|Summary|Input|Inputs|Sources|Result|Preview|Estimator|Layout|Sidebar|Section|Sections|Content|Chrome|Shell|Bar|Gate|Boundary|Menu|Tabs|Attachments|RichText|Detail|Fields|Table|Form|Ranking|Trend)$/u;
const COMPONENT_REPLAY_EXPORTS = new Set([
  'CollectionProductImageWorkspace',
  'DataMaintenancePanel',
  'FollowSellerDefensePage',
  'PaidPromotionPage',
  'CollectionProductListingSteps',
  'PromptLibraryQuickRunPanel',
  'PurchaseBrowserQuickActions',
  'MinimizedTaskBar',
  'WarehouseLogisticsPage',
]);
const COMPONENT_OVERRIDE_ONLY_EXPORTS = new Set([
  'CustomerMessageRichText',
]);

function reportProgress(message) {
  if (!progressEnabled) return;
  process.stderr.write(`[v2-ui-coverage] ${message}\n`);
}

class CoverageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    stubCalls.push({
      method: 'COMPONENT_RENDER_ERROR',
      url: String(this.props.sourceLabel || 'unknown-component'),
      error: String(error?.message || error).slice(0, 500),
    });
  }

  render() {
    return this.state.error ? null : this.props.children;
  }
}

const fixtureRow = Object.freeze({
  id: 'fixture-1',
  shopId: 'shop-fixture',
  shop_id: 'shop-fixture',
  clientId: 'client-fixture',
  hasApiKey: true,
  alias: '云测店铺',
  shopAlias: '云测店铺',
  name: '云测商品',
  title: '云测商品',
  productId: 'product-fixture',
  product_id: 'product-fixture',
  offerId: 'offer-fixture',
  offer_id: 'offer-fixture',
  sku: 'sku-fixture',
  orderKey: 'order-fixture',
  postingNumber: 'posting-fixture',
  posting_number: 'posting-fixture',
  status: 'active',
  ready: true,
  configured: true,
  enabled: true,
  value: 'fixture',
  label: '云测选项',
  url: 'https://fixture.invalid/item',
  imageUrl: 'https://fixture.invalid/image.webp',
  images: ['https://fixture.invalid/image.webp'],
  sourcePlatform: '1688',
  sourceUrl: 'https://fixture.invalid/item',
  description: '云测商品描述',
  attributes: [{ name: '颜色', value: '黑色' }],
  products: [],
  rows: [],
  items: [],
  options: [],
  onClick: () => {},
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
});

const fixtureShop = Object.freeze({
  ...fixtureRow,
  id: 'ozon-shop-1',
  shopId: 'ozon-shop-1',
  shop_id: 'ozon-shop-1',
  alias: '云测 Ozon 店铺',
  shopAlias: '云测 Ozon 店铺',
  name: '云测 Ozon 店铺',
  platform: 'ozon',
  platformCode: 'ozon',
  apiKey: 'fixture-api-key',
  profileId: 'model-account-fixture',
});

const fixtureOrder = Object.freeze({
  ...fixtureRow,
  id: 'order-fixture',
  orderId: 'order-fixture',
  order_id: 'order-fixture',
  shopId: 'ozon-shop-1',
  status: 'awaiting_packaging',
  price: 199,
  total: 199,
  currency: 'RUB',
  purchasePlatform: '1688',
  purchaseOrderNo: '1234567890',
  purchaseOrderUrl: 'https://fixture.invalid/purchase-order/1234567890',
  purchaseOrderLink: 'https://fixture.invalid/purchase-order/1234567890',
  orderUrl: 'https://fixture.invalid/purchase-order/1234567890',
  products: [
    { ...fixtureRow, id: 'after-sales-product-1', productId: 'after-sales-product-1', offerId: 'after-sales-offer-1', sku: 'after-sales-sku-1', skuId: 'after-sales-sku-1', name: '云测售后商品 1', title: '云测售后商品 1', quantity: 1 },
    { ...fixtureRow, id: 'after-sales-product-2', productId: 'after-sales-product-2', offerId: 'after-sales-offer-2', sku: 'after-sales-sku-2', skuId: 'after-sales-sku-2', name: '云测售后商品 2', title: '云测售后商品 2', quantity: 1 },
  ],
  createdAt: '2026-08-19T12:00:00.000Z',
});

const fixtureCampaign = Object.freeze({
  ...fixtureRow,
  id: 'campaign-fixture',
  campaignId: 'campaign-fixture',
  campaignName: '云测广告计划',
  name: '云测广告计划',
  status: 'running',
  statusLabel: '运行中',
  spend: 10,
  orders: 1,
  sales: 199,
});

function fixtureFunction(name) {
  if (/(?:Field|Handler|Factory)$/u.test(String(name))) {
    return vi.fn((...args) => {
      stubCalls.push({ method: 'COMPONENT_CALLBACK_FACTORY', url: String(name), args: args.length });
      return vi.fn();
    });
  }
  return vi.fn(async (...args) => {
    stubCalls.push({ method: 'COMPONENT_CALLBACK', url: String(name), args: args.length });
    return { ok: true, rows: [fixtureRow], items: [fixtureRow], data: fixtureRow, result: fixtureRow };
  });
}

function createFixtureProxy(seed = {}, depth = 0) {
  const functions = new Map();
  const nested = new Map();
  const arrayPattern = /(?:rows|items|options|shops|products|orders|records|tasks|jobs|files|images|models|accounts|activities|attributes|history|steps|tabs|plans|packages|notifications|warehouses|categories|batches|drafts|links|ids|results|domains|actions|scenes|phrases|usageinputs|backups|trend|entries|attachments|messages|replies|campaigns|sources|specs|bindings|counts|ledger|imports|marketingstats|imagecounts|groups|issues|failures)$/iu;
  const falsePattern = /^(?:disabled|loading|saving|pending|busy|submitting|deleting|readonly|readOnly|hidden|hasError|failed|isLoading|isSaving|isPending|isBusy)$/u;
  const truePattern = /^(?:open|visible|active|enabled|selected|expanded|authorized|connected|ready|checked|isOpen|isVisible|isActive|isEnabled|isReady)$/u;
  const functionPattern = /^(?:on|get|set|update|load|save|delete|close|open|show|hide|change|submit|select|refresh|cancel|confirm|toggle|navigate|copy|download|upload|run|retry|switch|choose|remove|add|edit|view|handle|clear|reset|execute|apply|start|read|minimize|restore|prepare|probe|test|scan|check|create|publish|preview|analyze|collect|export|import|mark|rebuild|release|reopen|continue|resume|scroll|focus|go)(?=[A-Z]|$)/u;
  return new Proxy(seed, {
    get(target, property) {
      if (property === Symbol.toStringTag) return 'Object';
      if (property === Symbol.toPrimitive) return (hint) => hint === 'number' ? 1 : 'fixture';
      if (property === Symbol.iterator) return function* fixtureIterator() { yield fixtureRow; };
      if (property === 'then') return undefined;
      if (property === 'toString') return () => 'fixture';
      if (property === 'valueOf') return () => 1;
      if (Object.hasOwn(target, property)) return target[property];
      const name = String(property);
      if (functionPattern.test(name)) {
        if (!functions.has(name)) functions.set(name, fixtureFunction(name));
        return functions.get(name);
      }
      if (falsePattern.test(name)) return false;
      if (truePattern.test(name)) return true;
      if (/(?:Error|Message)$/u.test(name)) return '';
      if (arrayPattern.test(name)) return [fixtureRow];
      if (/(?:count|total|page|index|step|balance|amount|price|stock|quantity|limit|size)$/iu.test(name)) return 1;
      if (/(?:id|key|name|label|title|status|type|mode|url|text|value|query)$/iu.test(name)) return fixtureRow[name] || `fixture-${name}`;
      if (/(?:state|model|config|settings|details|profile|draft|data|selection|result|module|package|shop|product|order|row|item)$/iu.test(name)) {
        if (depth > 3) return null;
        if (!nested.has(name)) nested.set(name, createFixtureProxy({}, depth + 1));
        return nested.get(name);
      }
      if (depth > 0) return `fixture-${name}`;
      if (!nested.has(name)) nested.set(name, createFixtureProxy({}, depth + 1));
      return nested.get(name);
    },
  });
}

function collectObjectPatternNames(pattern, target) {
  for (const property of pattern?.properties || []) {
    if (property.type === 'ObjectProperty' && property.key?.type === 'Identifier') target.add(property.key.name);
    else if (property.type === 'RestElement' && property.argument?.type === 'Identifier') target.add(property.argument.name);
  }
}

function collectComponentPropNames() {
  const names = new Set();
  for (const modulePath of Object.keys(componentModules)) {
    const absolutePath = path.resolve(process.cwd(), 'src/test', modulePath);
    let ast;
    try {
      ast = parse(fs.readFileSync(absolutePath, 'utf8'), {
        sourceType: 'module',
        plugins: ['jsx'],
      });
    } catch (error) {
      stubCalls.push({ method: 'COMPONENT_PROP_PARSE_SKIPPED', url: modulePath, error: String(error?.message || error) });
      continue;
    }
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
        && node.params?.[0]?.type === 'ObjectPattern'
      ) collectObjectPatternNames(node.params[0], names);
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object' && value.type) visit(value);
      }
    };
    visit(ast.program);
  }
  return names;
}

function inferredFixtureValue(name) {
  if (name === 'children') return null;
  if (/^(?:on|get|set|handle|update|load|save|delete|close|open|show|hide|change|submit|select|refresh|cancel|confirm|toggle|navigate|copy|download|upload|run|retry|switch|choose|remove|add|edit|view|clear|reset|execute|apply|start|read|minimize|restore|prepare|probe|test|scan|check|create|publish|preview|analyze|collect|export|import|mark|rebuild|release|reopen|continue|resume|scroll|focus|go)(?=[A-Z]|$)/u.test(name)) {
    return fixtureFunction(name);
  }
  if (/(?:Ids|IDs)$/iu.test(name)) return ['fixture-1'];
  if (/(?:Rows|Items|Options|Shops|Products|Orders|Records|Tasks|Jobs|Files|Images|Models|Accounts|Activities|Attributes|History|Steps|Tabs|Plans|Packages|Notifications|Warehouses|Categories|Batches|Drafts|Links|Attachments|Messages|Replies|Campaigns|Skus|SKUs|Groups|Templates|Domains|Fields|Columns|Entries|Results|Warnings|Errors|Scenes|Phrases|UsageInputs|Backups|Trend|Actions|Sources|Specs|Bindings|Counts|Ledger|Imports|MarketingStats|ImageCounts|Issues|Failures)$/iu.test(name)) {
    return [fixtureRow];
  }
  if (/^(?:open|visible|active|enabled|selected|expanded|authorized|connected|ready|checked|show[A-Z]|has[A-Z]|can[A-Z]|isOpen|isVisible|isActive|isEnabled|isReady)$/u.test(name)) return true;
  if (/^(?:disabled|loading|saving|pending|busy|submitting|deleting|readonly|readOnly|hidden|failed|isLoading|isSaving|isPending|isBusy)$/u.test(name)) return false;
  if (/(?:Count|Total|Page|Index|Step|Balance|Amount|Price|Stock|Quantity|Limit|Size)$/iu.test(name)) return 1;
  if (/(?:Id|ID|Key|Name|Label|Title|Status|Type|Mode|Url|URL|Text|Value|Query|Error|Message)$/iu.test(name)) {
    if (/(?:Status)$/iu.test(name)) return 'ready';
    if (/(?:Error|Message)$/iu.test(name)) return '';
    return fixtureRow[name] || `fixture-${name}`;
  }
  if (/(?:Ref)$/iu.test(name)) return { current: null };
  if (/^(?:anchorEl|menuAnchor|popoverAnchor)$/iu.test(name)) return null;
  return createFixtureProxy({
    ...fixtureRow,
    status: 'ready',
    loadError: '',
    error: '',
    readableShops: [fixtureRow],
    selectedPackage: fixtureRow,
    plans: [fixtureRow],
  }, 1);
}

const inferredFixtureProps = Object.fromEntries(
  [...collectComponentPropNames()].map((name) => [name, inferredFixtureValue(name)]),
);

const fixtureProps = createFixtureProxy({
  ...inferredFixtureProps,
  open: true,
  visible: true,
  saving: false,
  loading: false,
  disabled: false,
  rows: [fixtureRow],
  items: [fixtureRow],
  products: [fixtureRow],
  orders: [fixtureRow],
  shops: [fixtureShop],
  options: [fixtureRow],
  images: [fixtureRow.imageUrl],
  selectedShopIds: ['ozon-shop-1'],
  activeShopId: 'ozon-shop-1',
  selectedShopId: 'ozon-shop-1',
  uploadShopIds: ['ozon-shop-1'],
  selectedIds: ['fixture-1'],
  warehousesByShopId: { 'ozon-shop-1': [{ id: 'warehouse-fixture', rawId: 'warehouse-fixture', name: '云测仓库' }] },
  warehouseStatesByShopId: { 'ozon-shop-1': { status: 'ready', error: '' } },
  defaultInventoryByShopId: { 'ozon-shop-1': { warehouseId: 'warehouse-fixture', stock: 1 } },
  enabledSkuCount: 1,
  form: createFixtureProxy({ attributeValues: {}, values: {}, title: '云测商品', description: '云测商品描述' }, 1),
  collectorDraft: createFixtureProxy({ ...fixtureRow }, 1),
  browserState: { status: 'idle', error: '' },
  draft: createFixtureProxy({ ...fixtureRow }, 1),
  data: createFixtureProxy({ rows: [fixtureRow], items: [fixtureRow] }, 1),
  onAction: fixtureFunction('onAction'),
  onNotificationsRefresh: fixtureFunction('onNotificationsRefresh'),
  onSave: fixtureFunction('onSave'),
  onClose: fixtureFunction('onClose'),
  onOpen: fixtureFunction('onOpen'),
  onChange: fixtureFunction('onChange'),
  onSubmit: fixtureFunction('onSubmit'),
  onConfirm: fixtureFunction('onConfirm'),
  onCancel: fixtureFunction('onCancel'),
  onDelete: fixtureFunction('onDelete'),
  onRefresh: fixtureFunction('onRefresh'),
  onSelect: fixtureFunction('onSelect'),
  onUpdate: fixtureFunction('onUpdate'),
  onChangeField: vi.fn(() => fixtureFunction('onChangeField')),
  onChangeAttributes: fixtureFunction('onChangeAttributes'),
  onChangeDescription: fixtureFunction('onChangeDescription'),
});

const fixturePrompt = {
  id: 'prompt-fixture',
  name: '云测工具',
  title: '云测工具',
  description: '云测工具描述',
  category: '商品',
  scene: '商品优化',
  skillProfile: { modelCapability: 'text', usageInputs: [{ key: 'orderId', label: '订单号', type: 'text', required: true }] },
  promptConfig: { defaultModelId: 'fixture-model', imageModelId: 'fixture-image-model', plannerModelId: 'fixture-model' },
  usageInputs: [{ key: 'orderId', label: '订单号', type: 'text', required: true }],
  workflowSteps: [{ title: '读取数据', description: '读取测试数据' }],
  systemPrompt: '你是云测助手',
  userPrompt: '分析 {{orderId}}',
  outputFormat: 'Markdown',
};

const fixtureProduct = {
  ...fixtureRow,
  id: 'product-fixture',
  productId: 'product-fixture',
  shopId: 'ozon-shop-1',
  offerId: 'offer-fixture',
  title: '云测商品',
  attributes: [{ attributeId: '1001', id: '1001', name: '卖点', label: '卖点', value: '云测卖点', values: [{ value: '云测卖点' }] }],
  mainImages: [fixtureRow.imageUrl],
  detailImages: [fixtureRow.imageUrl],
  skus: [{ sku: 'sku-fixture', name: '黑色', enabled: true, price: 199, stock: 1, attributes: [{ name: '颜色', value: '黑色' }] }],
  skuOptions: [
    { id: 'sku-option-black', sku: 'sku-fixture', label: '黑色', facts: '黑色 · 500ml', mainImages: [fixtureRow.imageUrl], detailImages: [fixtureRow.imageUrl] },
    { id: 'sku-option-white', sku: 'sku-white', label: '白色', facts: '白色 · 500ml', mainImages: [fixtureRow.imageUrl], detailImages: [fixtureRow.imageUrl] },
  ],
};

const fixtureListingDraft = {
  ...fixtureProduct,
  title: '云测商品',
  description: '云测商品描述',
  sourcePlatform: '1688',
  sourceUrl: fixtureRow.sourceUrl,
  attributes: [{ name: '颜色', value: '黑色' }],
  attributeValues: { color: '黑色' },
  attributeDefinitions: [{ id: 'color', name: '颜色', type: 'text', required: true }],
  skus: fixtureProduct.skus,
  skuImages: [],
  weightG: '500',
  packageLengthCm: '10',
  packageWidthCm: '10',
  packageHeightCm: '10',
  inventoryByShopId: { 'ozon-shop-1': { warehouseId: 'warehouse-fixture', stock: 1 } },
  uploadShopIds: ['ozon-shop-1'],
};

const fixtureEditorForm = {
  title: '云测工具',
  scene: '商品',
  status: '已启用',
  owner: '云测',
  goal: '验证工具配置界面',
  body: '云测工具说明',
  defaultModelId: 'fixture-model',
  modelPurpose: '文本分析',
  workflowSteps: '读取测试数据\n生成测试报告',
  inputs: '订单号',
  outputs: 'Markdown 报告',
  systemPrompt: '## 身份与目标\n你是云测助手。\n\n## 工作流程\n读取测试数据。\n\n## 输出规则\n只返回测试结果。',
  userPrompt: '分析 {{订单号}}',
  outputFormat: 'Markdown',
  outputRules: '不得编造数据',
  safetyRules: '仅使用测试桩',
  capabilities: '本地预览',
  imagePositionRules: {
    main: [{ id: 'main-rule-fixture', title: '主图规则', prompt: '保持商品主体清晰', visible: true }],
    detail: [{ id: 'detail-rule-fixture', title: '详情图规则', prompt: '展示商品细节', visible: true }],
  },
  attributeRules: [{ id: 'attribute-rule-fixture', title: '属性规则', prompt: '保持属性真实', visible: true }],
  externalInsightConfig: { sections: [{ id: 'summary', title: '经营摘要', visible: true }], systemPrompt: '分析真实数据', userPrompt: '输出报告', outputSections: ['summary'], outputRules: ['不得编造'] },
  profitReviewPresentation: { paragraphIndent: true, sectionGap: 16, showBadge: true, metaFields: ['订单号'] },
};

const fixtureSharedModelBase = {
  readableShops: [fixtureShop],
  shops: [fixtureShop],
  activeShopId: 'ozon-shop-1',
  shop: 'ozon-shop-1',
  status: 'all',
  fulfillment: 'all',
  keyword: '云测',
  paymentStartDate: '2026-08-01',
  paymentEndDate: '2026-08-20',
  orderSync: { status: 'ready', message: '' },
  salesOrderRefreshProgress: { status: 'ready', message: '' },
  purchaseImageErrorText: '',
  salesSupplementErrorText: '',
  purchaseOrderPageSize: 20,
  salesOrderPageSize: 20,
  purchaseOrderPage: 1,
  salesOrderPage: 1,
  selectedPurchaseOrderKeys: new Set(['order-fixture']),
  selectedSalesOrderKeys: new Set(['order-fixture']),
  rows: [fixtureOrder],
  orders: [fixtureOrder],
  purchaseOrders: [fixtureOrder],
  salesOrders: [fixtureOrder],
  filteredOrders: [fixtureOrder],
  visibleOrders: [fixtureOrder],
  purchaseOrderStageCounts: { all: 1, pending: 1, purchased: 0, shipped: 0, completed: 0 },
  salesOrderStatusCounts: { all: 1, awaiting_packaging: 1, awaiting_deliver: 0, delivered: 0, cancelled: 0 },
  purchaseOrderTotalPages: 1,
  salesOrderTotalPages: 1,
  currentPurchaseOrderPage: 1,
  currentSalesOrderPage: 1,
  purchaseOrderRangeStart: 1,
  purchaseOrderRangeEnd: 1,
  salesOrderRangeStart: 1,
  salesOrderRangeEnd: 1,
  filteredPurchaseOrderKeys: ['order-fixture'],
  visiblePurchaseOrderKeys: ['order-fixture'],
  visibleSalesOrderKeys: ['order-fixture'],
  filteredOrderTotal: 1,
  selectedPurchaseOrderCount: 1,
  selectedSalesOrderCount: 1,
  purchaseBatchCancelCount: 1,
  purchaseBatchCancelExcludedCount: 0,
  allPurchasePageSelected: true,
  purchasePageSelectionIndeterminate: false,
  allSalesOrderPageSelected: true,
  salesOrderPageSelectionIndeterminate: false,
  selectionLoading: false,
  selectedCancellableOrders: [fixtureOrder],
  selectedShippableOrders: [fixtureOrder],
  selectedOrderActionItems: [{
    id: 'cancel',
    key: 'cancel',
    label: '取消订单',
    variant: 'outlined',
    color: 'inherit',
    disabled: false,
    onClick: fixtureFunction('selectedOrderAction'),
  }],
  selectedOrder: fixtureOrder,
  detailOrder: { ...fixtureOrder, products: [fixtureProduct], paymentTime: '2026-08-19 12:00:00', amount: 199 },
  hasSelectedOrder: true,
  selectedProducts: [fixtureProduct, { ...fixtureProduct, id: 'product-fixture-2', productId: 'product-fixture-2', offerId: 'offer-fixture-2', title: '云测商品 2' }],
  safeSelectedProductIndex: 0,
  selectedProduct: fixtureProduct,
  selectedSourceRecord: fixtureProduct,
  safeSelectedSourceSlot: 0,
  selectedSourceEntry: { link: fixtureRow.sourceUrl, image: fixtureRow.imageUrl, imageUrl: fixtureRow.imageUrl },
  selectedSourceLink: fixtureRow.sourceUrl,
  selectedActionState: { status: 'ready' },
  selectedActionFlags: { canCancel: true, canShip: true, canRefund: true },
  selectedVolumeItems: [fixtureProduct],
  selectedPackageSize: '10 × 10 × 10 cm',
  selectedPackageWeight: '0.5 kg',
  selectedPackageLength: '10',
  selectedPackageWidth: '10',
  selectedPackageHeight: '10',
  selectedLogisticsRouteText: '云测物流线路',
  selectedReadStatus: '已读取',
  manualPurchaseEditorOpen: true,
  manualPurchaseSummaryPlatform: '1688',
  manualPurchaseSummaryOrderNo: 'purchase-fixture',
  manualPurchaseSummaryPrice: '¥10',
  purchaseOrderPartialErrorText: '',
  salesOrderPartialErrorText: '',
  stats: [{ title: '订单总数', value: 1, hint: '云测数据', tone: 'primary' }],
  logisticsSync: { running: false, status: 'ready', message: '', completed: 1, total: 1, errors: [] },
  // Page views receive this slot as an already-rendered React node, not the
  // state object used by their parent controller.
  sideOrderSearch: null,
  detailSourceLink: fixtureRow.sourceUrl,
  detailSourceEntry: { link: fixtureRow.sourceUrl, image: fixtureRow.imageUrl, imageUrl: fixtureRow.imageUrl },
  detailCrossBorderInfo: { status: 'ready' },
  detailPurchaseInfoSupport: { sourceImage: fixtureRow.imageUrl, sourceLink: fixtureRow.sourceUrl, qty: 1 },
  detailSplitLocked: false,
  detailSplitLockReason: '',
  canCancelDetailOrder: true,
  canShipDetailOrder: true,
  canSplitDetailOrder: true,
  salesOzonProductWorkbench: { open: false, status: 'ready' },
  updateManualPurchaseDraftField: fixtureFunction('updateManualPurchaseDraftField'),
  handleSaveManualPurchaseInfo: fixtureFunction('handleSaveManualPurchaseInfo'),
  closeManualPurchaseEditor: fixtureFunction('closeManualPurchaseEditor'),
  manualPurchaseDraft: { platform: '1688', orderId: 'order-fixture' },
  purchaseNotice: { open: false, title: '', severity: 'info' },
  purchaseOperation: { open: true, type: 'normal', order: fixtureOrder, orders: [fixtureOrder], loading: false, cancelReason: '' },
  transferPendingDialog: { open: true, order: fixtureOrder },
  manualClassifyDialog: { open: true, order: fixtureOrder, anchorEl: null, pendingOption: null },
  sourceSearchDialog: { open: true, platform: '1688', title: '测试搜款', severity: 'info', loading: false, imageUrl: fixtureRow.imageUrl, searchUrl: 'https://fixture.invalid/search', results: [{ ...fixtureProduct, link: fixtureRow.sourceUrl, image: fixtureRow.imageUrl, hint: '云测货源' }] },
  purchaseOperationMeta: { title: '采购操作', body: '测试采购操作' },
  canSubmitPurchaseOperation: true,
  purchaseOrderWorkbenchDialog: { open: true, order: fixtureOrder, status: 'ready' },
  salesOperation: { open: true, type: 'split', order: fixtureOrder, loading: false, cancelReason: '' },
  operationMeta: { title: '销售操作', body: '测试销售操作' },
  isSplitSalesOperation: true,
  splitOperationOrder: fixtureOrder,
  splitValidation: { valid: true, total: 2, sum: 1 },
  splitPackages: [1],
  operationOrders: [fixtureOrder],
  canSubmitSalesOperation: true,
  resetPurchaseOrderListState: fixtureFunction('resetPurchaseOrderListState'),
  resetSalesOrderListState: fixtureFunction('resetSalesOrderListState'),
  applyTransferOrderToPending: fixtureFunction('applyTransferOrderToPending'),
  minimizePurchaseOrderWorkbench: fixtureFunction('minimizePurchaseOrderWorkbench'),
  startPurchaseOrderWorkbenchBrowser: fixtureFunction('startPurchaseOrderWorkbenchBrowser'),
  closePurchaseOrderWorkbench: fixtureFunction('closePurchaseOrderWorkbench'),
  retryPurchaseOrderWorkbench: fixtureFunction('retryPurchaseOrderWorkbench'),
  navigatePurchaseOrderWorkbench: fixtureFunction('navigatePurchaseOrderWorkbench'),
  readPurchaseOrderWorkbenchPaymentInfo: fixtureFunction('readPurchaseOrderWorkbenchPaymentInfo'),
  refreshPurchaseOrderWorkbenchStatus: fixtureFunction('refreshPurchaseOrderWorkbenchStatus'),
  savePurchaseOrderWorkbenchInfo: fixtureFunction('savePurchaseOrderWorkbenchInfo'),
};

const fixtureSharedModel = new Proxy(fixtureSharedModelBase, {
  get(target, property) {
    if (Object.hasOwn(target, property)) return target[property];
    const name = String(property);
    if (/^(?:on|set|update|load|save|delete|close|open|show|hide|change|submit|select|refresh|cancel|confirm|toggle|navigate|copy|download|upload|run|retry|switch|choose|remove|add|edit|view|handle|scroll|focus|go)/u.test(name)) {
      return fixtureFunction(name);
    }
    return inferredFixtureValue(name);
  },
});

function fixtureSharedModelVariant(overrides = {}) {
  return new Proxy({ ...fixtureSharedModelBase, ...overrides }, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return target[property];
      const name = String(property);
      if (/^(?:on|set|update|load|save|delete|close|open|show|hide|change|submit|select|refresh|cancel|confirm|toggle|navigate|copy|download|upload|run|retry|switch|choose|remove|add|edit|view|handle|scroll|focus|go)/u.test(name)) return fixtureFunction(name);
      return inferredFixtureValue(name);
    },
  });
}

function MarketingCardsCoverageHarness() {
  const activity = {
    id: 'activity-fixture',
    title: '云测活动',
    name: '云测活动',
    source: 'ozon',
    sourceTone: 'primary',
    count: 1,
    available: 1,
    estimate: 1,
  };
  const cards = useMarketingCardsState({
    selectedShopId: 'ozon-shop-1',
    handleMarketingShopChange: fixtureFunction('handleMarketingShopChange'),
    safeShops: [fixtureShop],
    activityFilter: 'all',
    setActivityFilter: fixtureFunction('setActivityFilter'),
    activityRows: [activity],
    handleSelectActivity: fixtureFunction('handleSelectActivity'),
    productScope: 'all',
    handleProductScopeChange: fixtureFunction('handleProductScopeChange'),
    pageSize: '20',
    setPageSize: fixtureFunction('setMarketingPageSize'),
    setProductPage: fixtureFunction('setMarketingProductPage'),
    keyword: '云测',
    setKeyword: fixtureFunction('setMarketingKeyword'),
    showSideProductSearch: true,
    selectedActivity: activity,
    marketingReviewRows: [{ label: '可提交', value: '1', progress: 100, color: 'success' }],
    isReadingProducts: false,
    hasLiveActivityData: true,
    refreshCurrentProductPool: fixtureFunction('refreshCurrentProductPool'),
    selectedCount: 1,
    planSubmitCount: 1,
    skippedCount: 0,
    discountPercent: '10',
    setDiscountPercent: fixtureFunction('setDiscountPercent'),
    handleCancelMarketingActivity: fixtureFunction('handleCancelMarketingActivity'),
    openMarketingWriteDialog: fixtureFunction('openMarketingWriteDialog'),
    handleSubmitMarketingChanges: fixtureFunction('handleSubmitMarketingChanges'),
    marketingWriteDialog: {
      tone: 'warning',
      title: '云测写入确认',
      activityTitle: '云测活动',
      actionText: '修改比例',
      productCount: 1,
      action: 'ratio',
      percent: 10,
      description: '只调用云测写入桩。',
      confirmLabel: '确认测试写入',
    },
    isMarketingWriting: false,
    marketingWriteDialogOpenRef: { current: true },
    setMarketingWriteDialog: fixtureFunction('setMarketingWriteDialog'),
    handleConfirmMarketingWrite: fixtureFunction('handleConfirmMarketingWrite'),
    marketingReminder: '云测处理提醒',
    reviewIssueCount: 0,
  });
  return (
    <Stack spacing={1}>
      {cards.marketingFilterCard}
      {cards.sideProductSearch}
      {cards.currentActivityCard}
      {cards.reviewResultCard}
      {cards.executionPlanCard}
      {cards.marketingWriteConfirmDialog}
      {cards.reminderCard}
    </Stack>
  );
}

function MinimizedTaskCoverageSeed({ children }) {
  const registry = useMinimizedTasks();
  const registerTask = registry?.registerTask;
  React.useEffect(() => {
    registerTask?.({
      id: 'v2-cloud-minimized-task',
      kind: 'purchase-order',
      title: '云测最小化任务',
      subtitle: '仅测试按钮恢复与关闭',
      restore: fixtureFunction('restoreMinimizedTask'),
      close: fixtureFunction('closeMinimizedTask'),
    });
  }, [registerTask]);
  return children;
}

function ThrowingCoverageChild() {
  throw new Error('V2 云端测试：验证应用错误边界');
}

const componentOverrides = {
  AppErrorBoundary: { children: <ThrowingCoverageChild /> },
  DashboardSectionHeader: { title: '云测看板分区', action: '查看详情' },
  PaidPromotionPage: { shops: [fixtureShop], activeShopId: 'ozon-shop-1', isActive: true },
  CollectionProductCategoryStep: { draft: fixtureListingDraft, definitions: fixtureListingDraft.attributeDefinitions, optionsByAttributeId: { color: [{ id: 'black', value: '黑色', label: '黑色' }] }, state: { status: 'ready', error: '' } },
  AttributeInput: { definition: fixtureListingDraft.attributeDefinitions[0], value: { value: '黑色', values: [] }, options: [{ id: 'black', value: '黑色', label: '黑色' }] },
  CollectionProductDetailsStep: { draft: fixtureListingDraft, definitions: fixtureListingDraft.attributeDefinitions, optionsByAttributeId: { color: [{ id: 'black', value: '黑色', label: '黑色' }] }, state: { status: 'ready', error: '' } },
  CollectionProductSetupStep: { draft: fixtureListingDraft, shops: [fixtureShop], selectedShopIds: ['ozon-shop-1'], state: { status: 'ready', error: '' } },
  CollectionProductSkuPriceStep: { draft: fixtureListingDraft, shops: [fixtureShop], selectedShopIds: ['ozon-shop-1'], state: { status: 'ready', error: '' }, pricing: { applySuggestedPrice: () => {}, toggleActivityPriceUpload: () => {} } },
  CollectionProductListingPreviewStep: { draft: fixtureListingDraft, shops: [fixtureShop], selectedShopIds: ['ozon-shop-1'], preview: { operationId: 'preview-fixture', shops: [{ shopId: 'ozon-shop-1', alias: '云测 Ozon 店铺' }], confirmed: false }, state: { status: 'ready', error: '' } },
  CollectionProductListingReadbackStep: { state: { status: 'pending', error: '', operationId: 'preview-fixture', shops: [{ shopId: 'ozon-shop-1' }] } },
  FollowSellerDefensePage: { shops: [fixtureShop], activeShopId: 'ozon-shop-1', isActive: true },
  RecoveryBackupCard: { recoveryOnly: false },
  NotificationCenterPopover: {
    open: true,
    anchorEl: document.body,
    shops: [fixtureShop],
    activeShopId: 'ozon-shop-1',
    localOrderNotifications: [{
      id: 'local-order-notification-fixture',
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: 'posting-fixture',
      shopId: 'ozon-shop-1',
      shopName: '云测 Ozon 店铺',
      productName: '云测商品',
      productSku: 'sku-fixture',
      oldValue: { status: 'awaiting_deliver' },
      newValue: { status: 'delivering' },
      createdAt: '2026-08-20T00:00:00.000Z',
      readAt: null,
    }],
    onApplyOrderNotifications: fixtureFunction('applyOrderNotifications'),
    onClearLocalOrderNotifications: fixtureFunction('clearLocalOrderNotifications'),
    onMarkLocalOrderNotificationsRead: fixtureFunction('markLocalOrderNotificationsRead'),
    onUnreadChange: fixtureFunction('notificationUnreadChange'),
  },
  PurchaseOrdersPageView: { model: fixtureSharedModel },
  PurchaseOrdersDialogs: { model: fixtureSharedModel },
  SalesOrdersPageView: { model: fixtureSharedModel },
  SalesOrderOperationDialog: { ...fixtureSharedModel },
  PromptLibraryImageGenerationRun: {
    selectedPrompt: fixturePrompt,
    values: { '商品图片或商品 SKU': '云测商品 · offer-fixture', 'SKU 信息': '黑色 · 500ml', '目标场景（可选）': '云测场景' },
    modelOptions: [{ id: 'fixture-image-model', accountId: 'model-account-fixture', name: '云测图片模型', label: '云测图片模型', displayName: '云测图片模型', model: 'fixture-image-model', provider: '云测', ready: true, statusLabel: '可用', options: {} }],
    textModelOptions: [{ id: 'fixture-model', accountId: 'model-account-fixture', name: '云测文本模型', label: '云测文本模型', displayName: '云测文本模型', model: 'fixture-model', provider: '云测', ready: true, statusLabel: '可用', options: {} }],
    shops: [fixtureShop],
    productSelection: { selectedProduct: fixtureProduct, selectedSku: fixtureProduct.skuOptions[0], visibleProducts: [fixtureProduct], hasLocalProducts: true, query: '', loading: false },
    draft: fixtureListingDraft,
    imageGeneration: {
      main: { status: 'success', result: { successCount: 1, items: [{ status: 'success', sourceIndex: 0, imageUrl: fixtureRow.imageUrl, previewUrl: fixtureRow.imageUrl }] } },
      detail: { status: 'success', result: { successCount: 1, items: [{ status: 'success', sourceIndex: 0, imageUrl: fixtureRow.imageUrl, previewUrl: fixtureRow.imageUrl }] } },
    },
    imagePromptPlan: { main: { sourceIndexes: [0] }, detail: { sourceIndexes: [0] } },
    productDescription: { status: 'success', fields: [{ id: '1001', value: '云测商品新卖点' }] },
    imageGenerationHistory: [{ id: 'history-fixture', accountId: 'model-account-fixture', shopId: 'ozon-shop-1', productKey: 'offer-fixture', productTitle: '云测商品', offerId: 'offer-fixture', sku: 'sku-fixture', groupLabel: '主图', model: 'fixture-image-model', plannerModel: 'fixture-model', createdAt: '2026-08-20T00:00:00.000Z', items: [{ sourceIndex: 0, imageUrl: fixtureRow.imageUrl }] }],
    workspaceMode: 'image',
    historyOpen: false,
  },
  DataBackupExportPanel: {
    shopOptions: [fixtureShop],
    shopId: 'ozon-shop-1',
    loading: false,
    exporting: false,
    canExport: true,
    confirmOpen: true,
    confirmMode: 'single',
    batchCount: 1,
    canBatchExport: true,
    domains: [{ domain: 'orders', label: '订单', recordCount: 1, required: true }],
    selectedDomains: ['orders'],
    fingerprint: 'fixture-fingerprint',
    message: null,
  },
  DataBackupHistoryPanel: {
    backups: [{ id: 'backup-fixture', createdAt: '2026-08-20T00:00:00.000Z', shopId: 'ozon-shop-1', domains: ['orders'] }],
    imports: [{ id: 'import-fixture', operationType: 'historical-order-import', fileName: '历史订单.csv', completedAt: '2026-08-20T00:00:00.000Z', rowCount: 1, status: 'completed', dimensionCandidates: [{ selectionKey: 'dimension-fixture' }] }],
  },
  DataBackupOverviewPanel: { shop: { ...fixtureShop, domains: [{ domain: 'orders', label: '订单', recordCount: 1 }] } },
  HistoricalDimensionSyncPanel: {
    model: {
      status: 'ready',
      candidates: [{ ...fixtureShop, selectionKey: 'dimension-fixture', productName: '云测商品', orderNumber: 'order-fixture', values: { weight: 500, length: 10, width: 10, height: 10 }, selected: true }],
      selectedKeys: ['dimension-fixture'],
      preview: { summary: { total: 1 }, items: [{ ...fixtureRow, selectionKey: 'dimension-fixture', productName: '云测商品', currentValues: { weight: 400, length: 9, width: 9, height: 9 }, proposedValues: { weight: 500, length: 10, width: 10, height: 10 }, source: { label: '云测历史订单', orderNumber: 'order-fixture' } }] },
      canPreview: true,
      canConfirm: true,
      toggleCandidate: fixtureFunction('toggleHistoricalDimensionCandidate'),
      runPreview: fixtureFunction('runHistoricalDimensionPreview'),
      runConfirm: fixtureFunction('runHistoricalDimensionConfirm'),
    },
  },
  HistoricalOrderImportPanel: {
    shopOptions: [fixtureShop],
    shopId: 'ozon-shop-1',
    model: {
      status: 'ready',
      message: null,
      sheet: { fileName: 'historical-orders.csv', rows: [fixtureOrder] },
      mappings: [{ columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' }],
      localResult: { rows: [fixtureOrder], skippedRows: 0, issues: [] },
      preview: {
        summary: { totalRows: 1, readyRows: 0, matchedRows: 0, selectionRequiredRows: 1, unmatchedRows: 0, conflictRows: 0, skippedRows: 0, invalidRows: 0 },
        rows: [{ rowIndex: 0, orderNumber: 'order-fixture', requiresSelection: true, productCandidates: [{ productIdentityId: 'product-fixture', productId: 'product-fixture', name: '云测商品' }] }],
      },
      productSelections: {},
      canPreflight: true,
      canConfirm: true,
      selectFile: fixtureFunction('selectHistoricalOrderFile'),
      downloadTemplate: fixtureFunction('downloadHistoricalOrderTemplate'),
      updateMapping: fixtureFunction('updateHistoricalOrderMapping'),
      updateProductSelection: fixtureFunction('updateHistoricalProductSelection'),
      runPreflight: fixtureFunction('runHistoricalOrderPreflight'),
      runConfirm: fixtureFunction('runHistoricalOrderConfirm'),
    },
  },
  SoftwareBackupRestorePanel: {
    shopOptions: [fixtureShop],
    model: {
      status: 'ready',
      message: null,
      targetShopId: 'ozon-shop-1',
      legacyPassphraseRequired: false,
      legacyPassphrase: '',
      canPreflight: true,
      canCommit: true,
      preview: {
        sourceShop: { displayName: '云测旧店铺' },
        targetShop: { displayName: '云测 Ozon 店铺' },
        exportedAt: '2026-08-20T00:00:00.000Z',
        summary: {
          totalRecords: 1,
          incomingRecords: 1,
          newRecords: 1,
          updateRecords: 0,
          preservedRecords: 0,
          conflictRecords: 0,
          skippedRecords: 0,
          failedRecords: 0,
        },
        domains: [{ domain: 'orders', label: '订单', recordCount: 1 }],
      },
      selectTargetShop: fixtureFunction('selectSoftwareBackupTargetShop'),
      setLegacyPassphrase: fixtureFunction('setSoftwareBackupPassphrase'),
      runPreflight: fixtureFunction('runSoftwareBackupPreflight'),
      runCommit: fixtureFunction('runSoftwareBackupCommit'),
    },
  },
  PromptLibraryListPanel: {
    prompts: [{
      ...fixturePrompt,
      skillProfile: { ...fixturePrompt.skillProfile, installType: 'skill-md', sourceUrl: 'https://fixture.invalid/SKILL.md' },
      toolMeta: {
        primaryActionLabel: '使用功能',
        availabilityTone: 'success',
        availabilityLabel: '云测可用',
        apiCapabilityMatch: { totalCount: 1, readyCount: 1, missingCount: 0 },
      },
    }],
    scenes: [{ value: 'scene-fixture', label: '商品优化' }],
    scene: 'scene-fixture',
    keyword: '',
    modelOptions: [{ id: 'fixture-model', name: '云测文本模型' }],
    imageModelOptions: [{ id: 'fixture-image-model', name: '云测图片模型' }],
  },
  PromptLibraryExternalProductResult: {
    result: {
      externalAnalysis: {
        overview: { recordCount: 26, totalSales: 260, totalRevenue: 5200, averagePrice: 20, averageRating: 4.8, totalStock: 100, averageReturnCancelRate: 1 },
        records: Array.from({ length: 26 }, (_item, index) => ({ ...fixtureProduct, id: `external-product-${index}`, sku: `external-sku-${index}`, title: `云测外部商品 ${index + 1}`, sales: index + 1, price: 20 })),
      },
    },
  },
  PromptLibraryExternalResultSections: {
    sections: [{ title: '云测明细', rows: Array.from({ length: 101 }, (_item, index) => `云测结果 ${index + 1}`) }],
  },
  PromptLibraryMarketKeywordResult: {
    result: {
      keywordAnalysis: {
        overview: { totalSearchVolume: 2600, averageGrowth: 10, averageCompetition: 20, averageSellers: 5 },
        records: Array.from({ length: 26 }, (_item, index) => ({ id: `keyword-${index}`, query: `云测关键词 ${index + 1}`, searchVolume: index + 1, platform: 'ozon' })),
      },
    },
  },
  PromptLibraryRepeatableInputList: {
    tool: fixturePrompt,
    label: '商品 SKU',
    value: 'sku-fixture\nsku-fixture-2',
    inputSpec: { maxItems: 20 },
  },
  PromptLibrarySeerfarCategoryPicker: {
    label: 'Seerfar 类目 ID',
    value: '1234',
    placeholder: '输入类目 ID',
  },
  PromptLibraryCategoryDialog: { categoryCounts: [{ id: 'scene-fixture', label: '商品优化', count: 1 }] },
  PromptLibraryStandardRun: {
    selectedPrompt: fixturePrompt,
    selectedShop: fixtureShop,
    usageInputs: ['订单号'],
    values: { 订单号: 'order-fixture' },
    textModelOptions: [{ id: 'fixture-model', label: '云测文本模型', displayName: '云测文本模型', model: 'fixture-model', provider: '云测', ready: true, statusLabel: '可用' }],
    imageModelOptions: [{ id: 'fixture-image-model', label: '云测图片模型', displayName: '云测图片模型', model: 'fixture-image-model', provider: '云测', ready: true, statusLabel: '可用' }],
    draft: { createdAt: '2026-08-20T00:00:00.000Z', result: { status: 'ready', title: '云测结果', sections: [{ title: '摘要', content: '云测通过' }] } },
    browserDataEnabled: false,
    externalDataEnabled: false,
    performanceAdEnabled: false,
    operationalWorkflowEnabled: false,
    operationalAnalysisRequired: false,
  },
  PromptLibraryQuickRunPanel: {
    open: true,
    selectedPrompt: {
      ...fixturePrompt,
      id: 'ozon-product-image-generation',
      goal: '云测商品标题、属性与图片生成',
      description: '根据商品信息生成标题、属性和商品图片',
      toolMeta: {
        apiCapabilityMatch: {
          executionPlan: {
            version: 1,
            steps: [{ id: 'model.text.generate' }, { id: 'model.image.generate' }],
            canStart: true,
            requiresImageExecution: true,
          },
        },
      },
    },
    selectedShop: fixtureShop,
    availableShops: [fixtureShop],
    usageInputs: [],
    values: { '商品图片或商品 SKU': '云测商品 · offer-fixture', 'SKU 信息': '黑色 · 500ml' },
    draft: { result: { status: 'ready' } },
    shops: [fixtureShop],
    productSelection: { selectedProduct: fixtureProduct, selectedSku: fixtureProduct.skuOptions[0], visibleProducts: [fixtureProduct], hasLocalProducts: true, query: '', loading: false },
    imageModelOptions: [{ id: 'fixture-image-model', accountId: 'model-account-fixture', model: 'fixture-image-model', ready: true, statusLabel: '可用' }],
    textModelOptions: [{ id: 'fixture-model', accountId: 'model-account-fixture', model: 'fixture-model', ready: true, statusLabel: '可用' }],
    imageGeneration: { main: { status: 'success', result: { successCount: 1, items: [{ status: 'success', sourceIndex: 0, imageUrl: fixtureRow.imageUrl }] } } },
    imagePromptPlan: { main: { sourceIndexes: [0] } },
    productDescription: { status: 'success', fields: [] },
    imageGenerationHistory: [{ id: 'history-fixture', groupLabel: '主图', createdAt: '2026-08-20T00:00:00.000Z', items: [{ imageUrl: fixtureRow.imageUrl }] }],
  },
  PromptLibrarySimpleEditorDialog: { open: true, editorForm: fixtureEditorForm },
  PromptLibraryEditorDialog: {
    open: true,
    editorMode: 'edit',
    editorForm: fixtureEditorForm,
    categories: [{ value: '商品', label: '商品' }],
    statusOptions: ['已启用', '已停用'],
    modelOptions: [{ id: 'fixture-model', label: '云测文本模型', statusLabel: '可用' }],
    installFileInputRef: { current: { click: fixtureFunction('installFileInputClick') } },
    installUrl: 'https://fixture.invalid/SKILL.md',
    installPreview: { ...fixturePrompt, status: '可安装', owner: '云测', sceneLabel: '商品', skillProfile: fixturePrompt.skillProfile, fixedInputs: ['订单号'], workflowSteps: fixturePrompt.workflowSteps, capabilities: ['本地预览'], outputs: ['Markdown 报告'], safetyRules: ['仅测试'] },
    installSourceLabel: '云测链接',
    installResolving: false,
    apiCapabilityMatch: null,
    canDelete: true,
  },
  ProfitOrderReviewRun: {
    tool: fixturePrompt,
    shops: [fixtureShop],
    modelOptions: [{ id: 'fixture-model', model: 'gpt-fixture', ready: true, statusLabel: '可用' }],
  },
  CustomerMessageAttachments: {
    shopId: 'ozon-shop-1',
    attachments: [{ id: 'attachment-fixture', type: 'image', url: 'https://api-seller.ozon.ru/v2/chat/file/file-fixture', name: '云测买家图片' }],
  },
  CustomerConversationThread: {
    conversation: {
      id: 'conversation-fixture',
      shopId: 'ozon-shop-1',
      title: '云测买家',
      subtitle: '订单 order-fixture',
      status: '待回复',
      updatedAt: '2026-08-20 12:00',
      unreadCount: 1,
      historyHasNext: true,
      messages: [{ id: 'message-fixture', role: 'system', domain: 'customerService', text: '云测系统消息'.repeat(40), attachments: [{ type: 'image', url: 'https://fixture.invalid/customer.webp' }, { type: 'image', url: 'https://fixture.invalid/customer-2.webp' }, { type: 'image', url: 'https://fixture.invalid/customer-3.webp' }] }],
    },
    translations: {},
    translationStatus: 'error',
    translationError: '云测翻译失败',
    unreadCount: 1,
    markReadSupported: true,
    markingRead: false,
    historyLoading: false,
    refreshing: false,
    syncing: false,
  },
  CustomerConversationList: {
    filters: [{ id: 'all', label: '全部' }],
    statusFilters: [{ id: 'all', label: '全部状态' }],
    conversations: [{ id: 'conversation-fixture', category: 'buyer', title: '云测买家', preview: '云测消息', unreadCount: 1, updatedAt: '2026-08-20 12:00' }],
    selectedFilterId: 'all',
    selectedStatusId: 'all',
    selectedConversationId: 'conversation-fixture',
    searchText: '',
    unreadCount: 1,
    actionableUnreadCount: 1,
    markReadSupported: true,
    syncStatus: 'ready',
    syncError: '云测同步告警',
    hasNext: true,
    loadingMore: false,
    markingRead: false,
    emptyReason: '没有更多会话',
  },
  CustomerMessageComposer: {
    conversationId: 'conversation-fixture',
    replyEnabled: true,
    replyUnavailableReason: '',
    draftText: '云测回复内容',
    sending: false,
  },
  CustomerMarkAllReadDialog: {
    state: {
      open: true,
      status: 'ready',
      scope: 'all',
      unreadMessages: 1,
      readOnlyUnreadMessages: 0,
      chats: [{ chatId: 'conversation-fixture' }],
      previewRows: [{ chatId: 'conversation-fixture', title: '云测买家', subtitle: '订单 order-fixture', categoryLabel: '买家', unreadCount: 1 }],
      result: { failures: [] },
      error: '',
    },
  },
  CustomerMessageSendDialog: {
    state: { open: true, status: 'ready', error: '', conversation: { chatId: 'conversation-fixture', title: '云测买家' }, text: '云测回复内容' },
  },
  CustomerQuickRepliesPanel: {
    phrases: [{ id: 'phrase-fixture', title: '云测短语', text: '云测回复内容', custom: true }],
    searchText: '',
    newPhraseText: '云测新增短语',
  },
  OzonBrowserLoginPanel: {
    title: '云测 Ozon 登录',
    description: '云测登录窗口等待中',
    onEnsureProfile: vi.fn(async () => ({ id: 'ozon-profile-fixture' })),
    onConnected: fixtureFunction('ozonBrowserConnected'),
  },
  OzonShopListCard: {
    shops: [{ ...fixtureShop, connectionStatus: '连接成功' }],
    activeShopId: 'ozon-shop-1',
    removalBusy: false,
    onAdd: fixtureFunction('addOzonShop'),
    onRemove: fixtureFunction('removeOzonShop'),
  },
  PurchaseBrowserTargetBar: {
    controller: {
      targetMode: {
        target: { orderKey: 'order-fixture', productTitle: '云测商品' },
        targetPhase: 'target-locked',
        captureBusy: false,
        clearTarget: fixtureFunction('clearPurchaseBrowserTarget'),
      },
    },
  },
  PurchaseCapturePreviewDialog: {
    controller: {
      targetMode: {
        targetPhase: 'capture-preview',
        captureBusy: false,
        captureError: '',
        captureResult: { platform: '1688', purchaseOrderNumber: 'purchase-fixture', purchasePrice: 10, currency: 'CNY', sourceUrl: fixtureRow.sourceUrl },
        capturePreview: { changes: { override: { purchaseOrderNumber: 'purchase-fixture' } }, missingFields: [], conflicts: ['采购单号'] },
        cancelCapture: fixtureFunction('cancelPurchaseCapture'),
        confirmCapture: fixtureFunction('confirmPurchaseCapture'),
      },
    },
  },
  SettingsModulePanel: {
    module: {
      title: '云测设置模块',
      description: '验证设置模块全部操作',
      status: '已配置',
      items: [{ title: '云测配置项', tag: '测试', text: '仅使用测试桩' }],
      actions: ['保存测试设置', '重新读取测试设置'],
    },
    actionNote: '云测操作说明',
  },
  CustomerConsultationTopStatusBar: {
    shops: [fixtureShop],
    activeShopId: 'ozon-shop-1',
    syncLabel: '云测已同步',
    syncTone: 'success',
    stats: [{ label: '未读', value: 1 }],
    shopProfile: { sellerName: '云测 Ozon 店铺', logoUrl: fixtureRow.imageUrl },
  },
  CustomerMessageRichText: {
    text: '云测消息：https://fixture.invalid/help',
    component: 'div',
    className: 'v2-cloud-rich-text',
    variant: 'body2',
    color: 'text.primary',
    align: 'inherit',
    gutterBottom: false,
    noWrap: false,
    paragraph: false,
    classes: {},
    sx: {},
  },
  MarketingActivitiesPageView: {
    model: createFixtureProxy({
      showReadNotice: false,
      activityRows: [{ id: 'activity-fixture', title: '云测活动', status: 'active' }],
      productScope: 'all',
      isReadingActivities: false,
      isReadingProducts: false,
      readNotice: '',
      readNoticeTone: 'info',
      selectedProductIds: ['product-fixture'],
      productCardRef: { current: null },
      selectedActivity: { id: 'activity-fixture', title: '云测活动' },
      productRows: [fixtureProduct],
      visibleProductRows: [fixtureProduct],
      totalProductPages: 3,
      currentProductPage: 2,
      allProductIds: ['product-fixture'],
      currentPageProductIds: ['product-fixture'],
      isAllProductsSelected: false,
      isCurrentPageSelected: false,
      selectedCount: 1,
      marketingStats: [{ title: '活动数', value: 1, hint: '云测', tone: 'primary' }],
      marketingFilterCard: null,
      sideProductSearch: null,
      currentActivityCard: null,
      reviewResultCard: null,
      executionPlanCard: null,
      marketingWriteConfirmDialog: null,
      reminderCard: null,
    }),
  },
  PointsPackageModelPresetDialog: {
    model: createFixtureProxy({
      modelPresetOpen: true,
      modelPresetSaving: false,
      modelPresetLoading: false,
      modelPresetError: '',
      modelPresetGroups: [{
        capabilityKind: 'text',
        label: '文本模型',
        enabledModels: ['model-a', 'model-b'],
        defaultModel: 'model-a',
        models: [
          { modelCode: 'model-a', displayName: '云测模型 A', apiStatus: 'available', canEnable: true, availableApiCount: 1, configuredApiCount: 1, pricedCapabilityCount: 1, totalCapabilityCount: 1 },
          { modelCode: 'model-b', displayName: '云测模型 B', apiStatus: 'available', canEnable: true, availableApiCount: 1, configuredApiCount: 1, pricedCapabilityCount: 1, totalCapabilityCount: 1 },
        ],
      }],
    }),
  },
  PointsPackagePaymentDialog: {
    model: createFixtureProxy({
      selectedPackage: { id: 'package-fixture', name: '云测积分包', title: '云测积分包', price: 1, points: 1000, paymentProviders: ['development'] },
      checkout: { payment: { provider: 'development' } },
      paymentMethod: 'development',
      paymentState: 'awaiting',
      paymentError: '',
      completeDevelopmentPayment: fixtureFunction('completeDevelopmentPayment'),
    }),
  },
  PointsPackageCard: {
    packageItem: { id: 'package-fixture', name: '云测积分包', title: '云测积分包', description: '云测套餐', price: 1, points: 1000, badge: '测试', features: ['云测功能'] },
  },
  PointsPackagePlansPanel: {
    model: createFixtureProxy({
      loadError: '云测套餐读取失败',
      packages: [{ id: 'package-fixture', name: '云测积分包', title: '云测积分包', price: 1, points: 1000, features: [] }],
      imageModelId: 'image-model-fixture',
      imageCount: 1,
      imageCounts: [1, 3, 5],
      imageModels: [{ id: 'image-model-fixture', name: '云测图片模型', description: '云测模型说明', qualityLabel: '标准图', usageLabel: '商品主图', unitPoints: 53, unitPriceCny: 0.05 }],
      imageModel: { id: 'image-model-fixture', name: '云测图片模型', description: '云测模型说明', qualityLabel: '标准图', usageLabel: '商品主图', unitPoints: 53, unitPriceCny: 0.05 },
      pointsPerLink: 53,
      includeRetryReserve: true,
    }),
  },
  PointsPackageEstimator: {
    imageModelId: 'image-model-fixture',
    imageCount: 1,
    imageCounts: [1, 3, 5],
    imageModels: [{ id: 'image-model-fixture', name: '云测图片模型', description: '云测模型说明', qualityLabel: '标准图', usageLabel: '商品主图', unitPoints: 53, unitPriceCny: 0.05 }],
    imageModel: { id: 'image-model-fixture', name: '云测图片模型', description: '云测模型说明', qualityLabel: '标准图', usageLabel: '商品主图', unitPoints: 53, unitPriceCny: 0.05 },
    pointsPerLink: 53,
    includeRetryReserve: true,
  },
  DataAnalysisAdvertisingPanel: {
    state: { status: 'error', data: null, error: { message: '云测广告读取失败' }, refresh: fixtureFunction('refreshAdvertisingData') },
  },
  DataAnalysisMarketPanel: {
    sources: [{ id: 'seerfar', source: 'seerfar', label: 'Seerfar', status: 'ready' }],
    marketState: {
      status: 'ready',
      query: '云测关键词',
      data: { datasetViews: [{ id: 'market-fixture', label: '云测市场数据', rows: [fixtureProduct] }], rows: [fixtureProduct] },
      setQuery: fixtureFunction('setMarketQuery'),
    },
  },
  DataAnalysisTrendPanel: {
    trend: [{ date: '2026-08-20', orderCount: 1, revenue: 199, profit: 20, sales: { breakdown: [{ id: 'sales', label: '销售额', value: 199 }] } }],
  },
  DataAnalysisDiagnosticsPanel: {
    rows: [{ id: 'diagnostic-fixture', title: '云测经营提醒', description: '云测需处理', severity: 'warning', moduleId: 'products' }],
  },
  DataAnalysisOverviewContent: {
    dashboard: {
      overview: {
        metrics: [{ id: 'trafficSessionCount', label: '访问人数', value: 10 }],
        trend: [{ date: '2026-08-20', orderCount: 1, revenue: 199 }],
      },
      finance: { metrics: [{ id: 'financeNetAmount', label: '净收入', value: 199 }] },
      traffic: { funnel: [], coverage: { complete: true } },
      diagnostics: [{ id: 'diagnostic-fixture', title: '云测经营提醒', action: '检查商品', severity: 'medium', moduleId: 'products' }],
      sales: { productRanking: [] },
    },
  },
  DataAnalysisPanelShell: {
    title: '云测数据面板',
    subtitle: '云测只读数据摘要',
    sourceLabel: '本地测试桩',
    action: null,
    children: <div>云测面板内容</div>,
    dense: false,
    ariaLabel: '云测数据面板',
  },
  DataAnalysisInsightDialog: {
    open: true,
    dashboard: { generatedAt: '2026-08-20T00:00:00.000Z', totals: { revenue: 199, orders: 1 } },
    filters: { shopId: 'ozon-shop-1', startDate: '2026-08-01', endDate: '2026-08-20' },
    state: { status: 'error', error: { message: '云测分析失败' } },
    modelOptions: [{ id: 'fixture-model', model: 'fixture-model', label: '云测文本模型', statusLabel: '可用', ready: true }],
    selectedModelId: 'fixture-model',
    modelSelection: { ready: true },
  },
  DataAnalysisInsightReport: {
    dashboard: { generatedAt: '2026-08-20T00:00:00.000Z', totals: { revenue: 199, orders: 1 } },
    filters: { shopId: 'ozon-shop-1', startDate: '2026-08-01', endDate: '2026-08-20' },
    state: { insight: '**一、总体结论**\n云测经营结论。\n\n## 二、商品分析\n云测商品分析。' },
    modelLabel: '云测文本模型',
    modelReady: true,
    loading: false,
  },
  DataAnalysisModuleContent: {
    activeModuleId: 'traffic',
    dashboard: { traffic: { trend: [], funnel: [], coverage: {}, sourceSyncedAt: '' } },
    isRefreshing: false,
  },
  DataAnalysisTrafficTrend: {
    trend: [{ date: '2026-08-20', sessions: 10, views: 20, cartAdditions: 3, orderedUnits: 1, revenueCny: 199 }],
    coverage: { days: 1 },
  },
  DataAnalysisOverviewProductRanking: {
    rows: [{ key: 'ranking-fixture', offerId: 'offer-fixture', sku: 'sku-fixture', title: '云测商品', quantity: 1, revenue: 199 }],
    onOpenModule: fixtureFunction('openDataAnalysisModule'),
  },
  AccountRemovalBackupGate: {
    review: {
      required: true,
      totalRecords: 1,
      dataFingerprint: 'data-fingerprint-fixture',
      domains: [{ domain: 'orders', label: '订单', recordCount: 1 }],
      latestVerifiedBackup: { backupId: 'backup-fixture', verified: true, survivesAccountRemoval: true, dataFingerprint: 'data-fingerprint-fixture', verifiedAt: '2026-08-20T00:00:00.000Z' },
    },
    authorization: null,
    busy: false,
  },
  AccountRemovalPreviewDialog: {
    busy: false,
    flow: {
      open: true,
      stage: 'error',
      account: { id: 'account-fixture', name: '云测账号' },
      owner: { ownerId: 'owner-fixture', label: '云测账号' },
      preview: { previewFingerprint: 'preview-fixture', owner: { ownerId: 'owner-fixture' }, resources: [], preserveResources: [], deleteResources: [] },
      backupReview: { required: false, domains: [], totalRecords: 0 },
      backupAuthorization: null,
      backupError: '',
      operation: null,
    },
  },
  ProductBatchDialog: {
    open: true,
    batchDialog: { open: true, action: 'stock', stockValue: '1', warehouseId: 'warehouse-fixture' },
    activeBatchMeta: { type: 'stock', title: '批量修改库存', inputLabel: '库存', confirmLabel: '确认修改' },
    selectedCount: 1,
    batchSaving: false,
    batchWarehouseLoading: false,
    batchWarehouseError: '',
    batchWarehouseOptions: [{ id: 'warehouse-fixture', rawId: 'warehouse-fixture', name: '云测仓库' }],
  },
  CollectionProductSkuWorkspace: {
    skus: [
      { id: 'sku-fixture', name: '黑色', attributes: [{ name: '颜色', value: '黑色' }], price: '10', imageUrl: fixtureRow.imageUrl, enabled: true, weightG: '500', packageLengthCm: '10', packageWidthCm: '10', packageHeightCm: '10' },
      { id: 'sku-fixture-2', name: '白色', attributes: [{ name: '颜色', value: '白色' }], price: '11', imageUrl: fixtureRow.imageUrl, enabled: true, weightG: '500', packageLengthCm: '10', packageWidthCm: '10', packageHeightCm: '10' },
    ],
  },
  CollectionProductCategoryPickerDialog: {
    open: true,
    options: [{
      descriptionCategoryId: '10',
      typeId: '20',
      name: 'V2 云端测试电脑音响系统',
      pathText: '电子产品 > 音响和扬声器 > V2 云端测试电脑音响系统',
    }],
    value: {
      descriptionCategoryId: '10',
      typeId: '20',
      name: 'V2 云端测试电脑音响系统',
      pathText: '电子产品 > 音响和扬声器 > V2 云端测试电脑音响系统',
    },
    templateState: {
      status: 'ready',
      categoryKey: '10:20',
      template: {
        descriptionCategoryId: '10',
        typeId: '20',
        definitions: [{ id: 'color', name: '颜色', type: 'text', required: true }],
        optionsByAttributeId: {},
        dictionaryLoadedIds: [],
        dictionaryFailedIds: [],
      },
    },
  },
  CollectionProductEditorSidebar: {
    product: fixtureProduct,
    draft: {
      ...fixtureListingDraft,
      editorSettings: { textModelId: 'auto', imageModelId: 'auto', imageSize: '1024x1024', imageQuality: 'auto' },
    },
    textModelOptions: [],
    imageModelOptions: [],
    imageSizeOptions: [{ id: '1024x1024', label: '1024 × 1024' }],
    imageQualityOptions: [{ id: 'auto', label: '自动' }],
  },
  CollectionProductImageHistoryDialog: {
    open: true,
    history: {
      shopId: 'ozon-shop-1',
      productTitle: '云测商品',
      sourceUrl: fixtureRow.sourceUrl,
      entries: [{
        id: 'history-fixture',
        group: 'main',
        groupLabel: '主图',
        sourceProductId: 'product-fixture',
        createdAt: '2026-08-20T00:00:00.000Z',
        items: [{ sourceIndex: 0, status: 'success', previewUrl: fixtureRow.imageUrl, imageUrl: fixtureRow.imageUrl }],
      }],
    },
  },
  CollectionProductImageWorkspace: {
    draft: {
      ...fixtureListingDraft,
      mainImages: [fixtureRow.imageUrl, 'https://fixture.invalid/image-2.webp'],
      skuImages: [{ skuId: 'sku-fixture', skuName: '黑色', imageUrl: fixtureRow.imageUrl }],
      detailImages: ['https://fixture.invalid/detail.webp'],
    },
    generationState: {
      status: 'success',
      message: '云测生成完成',
      itemsByGroup: {
        main: [{ status: 'success', sourceIndex: 0, previewUrl: 'https://fixture.invalid/generated.webp', imageUrl: 'https://fixture.invalid/generated.webp' }],
      },
    },
    imageSkillState: { status: 'ready', rules: [] },
    imageHistory: {
      imageCount: 1,
      shopId: 'ozon-shop-1',
      productTitle: '云测商品',
      entries: [{ id: 'history-fixture', group: 'main', groupLabel: '主图', items: [{ sourceIndex: 0, previewUrl: fixtureRow.imageUrl, imageUrl: fixtureRow.imageUrl }] }],
    },
  },
  CollectionProductPricingSummary: {
    pricing: {
      summary: {
        logisticsLabel: '云测物流',
        commissionPercent: 10,
        marginRange: { minimum: 20, maximum: 25 },
        breakEvenRange: { minimum: 100, maximum: 120 },
        totalCostRange: { minimum: 80, maximum: 90 },
        profitRange: { minimum: 20, maximum: 30 },
      },
      providers: [{ id: 'provider-fixture', label: '云测物流商' }],
      logisticsDraft: { providerId: 'provider-fixture' },
      pricingDraft: { ozonFeePercent: '10', expectedProfitCny: '20' },
      commissionState: { message: '云测扣点' },
      changeLogistics: fixtureFunction('changeCollectionLogistics'),
      changePricingField: fixtureFunction('changeCollectionPricingFieldFactory'),
    },
  },
  CollectionProductEditDialog: {
    product: {
      ...fixtureProduct,
      purchasePrice: '10',
      purchasePriceMin: '10',
      weightG: '500',
      packageLengthCm: '10',
      packageWidthCm: '10',
      packageHeightCm: '10',
      editorSettings: { textModelId: 'auto', imageModelId: 'auto', imageSize: '1024x1024', imageQuality: 'auto' },
    },
    shops: [fixtureShop],
    activeShopId: 'ozon-shop-1',
  },
  WorkspaceTabs: {
    tabs: [
      { id: 'dashboard', label: '旺崽汇总', icon: null, fixed: true },
      { id: 'products', label: '商品列表', icon: null, fixed: false },
    ],
    currentPage: 'products',
  },
  ProductAttributeEditor: {
    attributeRows: [{ id: 'boolean-fixture', attributeId: 'boolean-fixture', label: '是否云测', type: 'boolean', valueType: 'boolean', filled: false, required: true }],
    attributeOptionsById: {},
    attributeOptionsLoading: {},
    form: { attributeValues: { 'boolean-fixture': 'false' } },
    saving: false,
    attributeLoading: false,
  },
  ProductEditDialog: {
    open: true,
    product: {
      ...fixtureProduct,
      images: [fixtureRow.imageUrl],
      raw: { detail: { rich_content_json: JSON.stringify({ content: [{ widgetName: 'raShowcase', content: { items: [{ imageUrl: 'https://fixture.invalid/detail.webp' }] } }] }) } },
    },
    shop: fixtureShop,
    saving: false,
  },
  ProductListPageView: {
    model: createFixtureProxy({
      isVisible: true,
      shops: [fixtureShop],
      activeShop: fixtureShop,
      canReadOzon: true,
      shop: 'ozon-shop-1',
      status: '全部',
      keyword: '',
      loading: false,
      productLoadError: '',
      editingProduct: null,
      savingProductId: '',
      productNotice: { open: false, severity: 'info', message: '' },
      page: 1,
      pageSize: 20,
      selectedProductKeys: new Set(['product-fixture']),
      batchAnchorEl: null,
      batchDialog: { open: false },
      archiveConfirmDialog: { open: false },
      batchSaving: false,
      advancedFilterAnchorEl: null,
      advancedFilters: { status: ['active'] },
      productRefreshProgress: { blocking: false, running: false, message: '', completed: 1, total: 1, errors: [] },
      advancedFilterOpen: false,
      hasAdvancedFilters: true,
      advancedFilterGroups: [{ id: 'status', label: '状态', options: [{ value: 'active', label: '在售' }] }],
      advancedFilterChips: [{ key: 'status-active', label: '状态：在售', filterKey: 'status', value: 'active' }],
      visibleProductStatusCounts: { 全部: 1, 在售: 1 },
      filteredProducts: [fixtureProduct],
      productPagination: { totalRows: 1, currentPage: 1, pageSize: 20 },
      totalPages: 1,
      renderedPageProducts: [fixtureProduct],
      pageProductKeys: ['product-fixture'],
      selectedProducts: [fixtureProduct],
      allPageSelected: true,
      pageSelectionIndeterminate: false,
      batchPopoverOpen: false,
      pendingProductArchiveKeys: new Set(),
      batchWarehouseOptions: [{ id: 'warehouse-fixture', name: '云测仓库' }],
      batchWarehouseLoading: false,
      batchWarehouseError: '',
      productRefreshPercent: 100,
      productThinProgressVisible: false,
      productTablePageBusy: false,
      renderHeaderLabel: (label) => label,
      renderSortableHeader: (label) => label,
    }),
  },
  ProductTableRows: {
    products: [fixtureProduct],
    renderEnabled: true,
    selectedProductKeys: new Set(['product-fixture']),
    savingProductId: '',
    pendingProductArchiveKeys: new Set(),
    canReadOzon: true,
  },
  PromptLibraryProductSelectionSources: {
    sourceSearch: {
      message: '云测货源搜索完成',
      statusLabel: '等待核对',
      searches: [{ query: '云测商品', url: 'https://fixture.invalid/search-a' }],
      candidates: [{ id: 'source-fixture', title: '云测 1688 货源', hint: '人工核对', image: fixtureRow.imageUrl, link: 'https://fixture.invalid/source' }],
      searchUrl: 'https://fixture.invalid/search',
      keywordSearchUrl: 'https://fixture.invalid/keyword-search',
      imageSearchUrl: 'https://fixture.invalid/image-search',
      sourceImage: { title: '云测参考图' },
    },
  },
  ProductAdvancedFilterPopover: { groups: [{ id: 'status', label: '状态', options: [{ value: 'active', label: '在售' }] }] },
  PurchaseOrderWorkbenchSidebar: {
    presentation: {
      sidebarKind: 'order',
      product: { title: '云测商品', imageUrl: fixtureRow.imageUrl },
      order: { orderNo: 'order-fixture', ozonOrderId: 'ozon-order-fixture', shop: '云测 Ozon 店铺', status: '待拍单', goodsNo: 'offer-fixture', paymentTime: '2026-08-20 12:00' },
      source: { platform: '1688', amount: '¥10' },
      logistics: { weight: '500g', size: '10×10×10cm', route: '云测线路', readStatus: '已读取' },
      profitItems: [{ label: '预估利润', value: '¥20', tone: 'success' }],
    },
    operation: '',
    disabled: false,
    refreshDisabled: false,
    pendingSave: true,
  },
  WarehouseFreightEstimatorCard: { activeShop: fixtureShop, warehouses: [{ id: 'warehouse-fixture', name: '云测仓库' }], methodRows: [{ id: 'standard', label: 'Standard' }], productRows: [fixtureProduct], selectedWarehouse: 'warehouse-fixture', selectedMethod: 'standard', selectedProduct: 'product-fixture' },
  ProductSaveConfirmDialog: {
    open: true,
    saving: false,
    saveChangeItems: ['标题'],
    changedAttributeRows: [{ id: 'color', label: '颜色' }],
    productCardDiff: {
      changes: [{ field: 'name', label: '标题', before: '旧标题', after: '云测商品', writeStage: 'write_guard_only', writeLabel: '安全门写入', policy: { endpointKey: 'products.import' } }],
    },
  },
  OzonShopProfileCard: {
    activeShop: { ...fixtureShop, connectionStatus: '连接成功', connectionMessage: '云测连接正常', lastTestAt: '2026-08-20 12:00', savedAt: '2026-08-20 12:00' },
    activeClientId: 'client-fixture',
    hasStoredApiKey: true,
    connectionColor: 'success',
    purchaseManagementStartedAtText: '2026-08-20 12:00',
    licenseExpirationText: '2026-09-20 12:00',
  },
  ShopSettingsDialog: {
    open: true,
    initialModule: 'ozon',
    shops: [{ ...fixtureShop, connectionStatus: '连接成功', connectionMessage: '云测连接正常' }],
    activeShopId: 'ozon-shop-1',
    accountRemovalBusy: false,
    deferInitialRender: false,
    onAdd: vi.fn(async ({ cardKey } = {}) => {
      if (!cardKey) {
        const error = new Error('新增店铺需要卡密');
        error.code = 'ADDITIONAL_SHOP_CARD_REQUIRED';
        throw error;
      }
      return { ok: true, shopId: 'ozon-shop-2' };
    }),
    onGetLicenseExpiration: vi.fn(async () => ({ expireAt: '2026-09-20T00:00:00.000Z' })),
  },
  StructuredSettingsLayout: {
    config: {
      id: 'fixture-settings',
      mainTitle: '云测结构化设置',
      listTitle: '云测配置',
      records: [{ id: 'settings-record-fixture', title: '云测配置', status: '已配置', statusColor: 'success', values: {} }],
      sections: [],
      fields: [],
    },
    actionNote: '仅使用云测测试桩',
    shops: [fixtureShop],
  },
};

const componentOverrideVariants = {
  RecoveryBackupCard: [
    componentOverrides.RecoveryBackupCard,
    { recoveryOnly: true },
  ],
  PurchaseOrderWorkbenchDialog: [
    {
      dialog: {
        open: true,
        minimized: false,
        requestKey: 'purchase-workbench-fixture',
        url: 'https://fixture.invalid/purchase-order/1234567890',
        shopId: 'ozon-shop-1',
        browserTabId: 'purchase-tab-fixture',
        status: 'ready',
        presentation: { title: '云测订单操作台', subtitle: '云测采购订单' },
      },
    },
    {
      dialog: {
        open: true,
        minimized: false,
        requestKey: 'purchase-workbench-error-fixture',
        url: 'https://fixture.invalid/purchase-order/1234567890',
        shopId: 'ozon-shop-1',
        browserTabId: 'purchase-tab-fixture',
        status: 'error',
        error: '云测网页加载失败',
        presentation: { title: '云测订单操作台', subtitle: '云测采购订单' },
      },
    },
  ],
  PurchaseOrdersPageView: [
    componentOverrides.PurchaseOrdersPageView,
    {
      model: fixtureSharedModelVariant({
        selectedProducts: [fixtureProduct, { ...fixtureProduct, id: 'product-fixture-2', sku: 'sku-fixture-2', title: '云测商品 2' }],
        safeSelectedProductIndex: 1,
        selectedProduct: { ...fixtureProduct, id: 'product-fixture-2', sku: 'sku-fixture-2', title: '云测商品 2' },
      }),
    },
    {
      model: fixtureSharedModelVariant({
        filteredOrders: [
          fixtureOrder,
          { ...fixtureOrder, id: 'order-fixture-2', orderId: 'order-fixture-2', orderNumber: 'order-fixture-2' },
        ],
        filteredPurchaseOrderKeys: ['order-fixture', 'order-fixture-2'],
        selectedPurchaseOrderCount: 1,
        purchasePlatformExpanded: true,
        selectedActionFlags: {
          ...fixtureSharedModel.selectedActionFlags,
          status: '待拍单',
        },
      }),
    },
  ],
  SalesOrdersPageView: [
    componentOverrides.SalesOrdersPageView,
    {
      model: fixtureSharedModelVariant({
        canCancelDetailOrder: false,
        canShipDetailOrder: false,
        canSplitDetailOrder: true,
        salesOperation: { open: false, type: '', order: null, loading: false, error: null },
      }),
    },
  ],
  CollectionProductEditDialog: [
    componentOverrides.CollectionProductEditDialog,
    {
      ...componentOverrides.CollectionProductEditDialog,
      // The source-only editing path starts directly on the image step. This is
      // the production state where the footer's "上一步" action is rendered;
      // no category validation or external Ozon request is needed to reach it.
      shops: [],
      activeShopId: '',
    },
  ],
  AttributeInput: [
    componentOverrides.AttributeInput,
    {
      ...componentOverrides.AttributeInput,
      definition: { ...fixtureListingDraft.attributeDefinitions[0], isDictionary: true },
      options: [{ id: 'black', value: '黑色', label: '黑色' }],
    },
  ],
  CollectionProductCategoryStep: [
    componentOverrides.CollectionProductCategoryStep,
    {
      ...componentOverrides.CollectionProductCategoryStep,
      options: [{ id: 'category-fixture', value: 'category-fixture', label: '云测类目', typeId: 'type-fixture', descriptionCategoryId: 'category-fixture' }],
      state: { status: 'ready', error: '' },
    },
  ],
  CollectionProductDetailsStep: [
    componentOverrides.CollectionProductDetailsStep,
    { ...componentOverrides.CollectionProductDetailsStep, state: { status: 'error', error: '云测读取失败' }, onReload: fixtureFunction('reloadCollectionDetails') },
    { ...componentOverrides.CollectionProductDetailsStep, definitions: [], state: { status: 'ready', error: '' }, onReload: fixtureFunction('reloadCollectionDefinitions') },
    {
      ...componentOverrides.CollectionProductDetailsStep,
      definitions: [
        ...fixtureListingDraft.attributeDefinitions,
        { id: 'optional-fixture', name: '可选属性', type: 'text', is_required: false },
      ],
      state: { status: 'ready', error: '' },
    },
  ],
  CollectionProductSetupStep: [
    componentOverrides.CollectionProductSetupStep,
    {
      ...componentOverrides.CollectionProductSetupStep,
      draft: { ...fixtureListingDraft, categorySelectionSource: 'manual', descriptionCategoryId: 'category-fixture', typeId: 'type-fixture' },
      definitions: fixtureListingDraft.attributeDefinitions.map((definition) => ({ ...definition, isAspect: true })),
      attributeState: { status: 'ready', error: '' },
      attributeAutofillState: { status: 'ready', error: '' },
      onAnalyzeAndFill: fixtureFunction('analyzeAndFillCollectionAttributes'),
    },
  ],
  CollectionProductSkuPriceStep: [
    componentOverrides.CollectionProductSkuPriceStep,
    {
      ...componentOverrides.CollectionProductSkuPriceStep,
      draft: {
        ...fixtureListingDraft,
        skus: [
          { ...fixtureProduct.skus[0], sourceSkuId: 'source-sku-1', sourceSkuName: '黑色', attributeValues: { color: '黑色' } },
          { ...fixtureProduct.skus[0], sku: 'sku-white', offerId: 'offer-white', sourceSkuId: 'source-sku-2', sourceSkuName: '白色', attributeValues: { color: '白色' } },
        ],
      },
      definitions: fixtureListingDraft.attributeDefinitions.map((definition) => ({ ...definition, isAspect: true, is_required: true })),
      selectedShopIds: [],
      pricing: { canGenerateSkuPrices: true, applyState: { status: 'ready' }, applySuggestedPrice: fixtureFunction('applySuggestedSkuPrice'), toggleActivityPriceUpload: fixtureFunction('toggleActivityPriceUpload') },
    },
  ],
  CollectionProductEditorSidebar: [
    componentOverrides.CollectionProductEditorSidebar,
    {
      ...componentOverrides.CollectionProductEditorSidebar,
      textModelOptions: [{ id: 'fixture-model', model: 'fixture-model', displayName: '云测文本模型', ready: true }],
      imageModelOptions: [{ id: 'fixture-image-model', model: 'fixture-image-model', displayName: '云测图片模型', ready: true }],
    },
  ],
  CollectionProductListingPreviewStep: [
    componentOverrides.CollectionProductListingPreviewStep,
    { ...componentOverrides.CollectionProductListingPreviewStep, preview: null, state: { status: 'previewing', message: '云测生成中', progressCurrent: 1, progressTotal: 2 } },
    { ...componentOverrides.CollectionProductListingPreviewStep, preview: null, state: { status: 'error', error: '云测预览失败' } },
    {
      ...componentOverrides.CollectionProductListingPreviewStep,
      preview: {
        ...componentOverrides.CollectionProductListingPreviewStep.preview,
        product: { offer_id: 'offer-fixture', name: '云测商品', description_category_id: 'category-fixture', type_id: 'type-fixture', images: ['https://fixture.invalid/image.webp'], attributes: [] },
        price: { price: 199, old_price: 299 },
        stocks: [{ offer_id: 'offer-fixture', stock: 1 }],
        draftSnapshot: { shopId: 'ozon-shop-1', skus: [{ offerId: 'offer-fixture', priceCny: 199, oldPriceCny: 299 }] },
      },
      state: { status: 'ready', error: '' },
    },
    { ...componentOverrides.CollectionProductListingPreviewStep, state: { status: 'previewing', message: '云测重新生成中' } },
  ],
  ProfitOrderReviewRun: [
    componentOverrides.ProfitOrderReviewRun,
    { ...componentOverrides.ProfitOrderReviewRun, modelOptions: [] },
  ],
  CustomerConversationThread: [
    componentOverrides.CustomerConversationThread,
    {
      ...componentOverrides.CustomerConversationThread,
      conversation: { ...componentOverrides.CustomerConversationThread.conversation, messages: [], historyHasNext: false, historyError: '云测历史消息读取失败' },
      translationStatus: 'idle',
      translationError: '',
      unreadCount: 0,
    },
  ],
  PromptLibraryQuickRunPanel: [
    componentOverrides.PromptLibraryQuickRunPanel,
    {
      ...componentOverrides.PromptLibraryQuickRunPanel,
      selectedPrompt: fixturePrompt,
      draft: { result: { status: 'ready', title: '云测文本结果' } },
      imageGeneration: null,
      imagePromptPlan: null,
      imageGenerationHistory: [],
    },
  ],
  CustomerConversationList: [
    componentOverrides.CustomerConversationList,
    { ...componentOverrides.CustomerConversationList, conversations: [], syncStatus: 'error', syncError: '云测会话读取失败', hasNext: false },
    { ...componentOverrides.CustomerConversationList, conversations: [], syncStatus: 'ready', syncError: '', hasNext: true },
  ],
  CustomerMarkAllReadDialog: [
    componentOverrides.CustomerMarkAllReadDialog,
    { ...componentOverrides.CustomerMarkAllReadDialog, state: { ...componentOverrides.CustomerMarkAllReadDialog.state, status: 'success' } },
  ],
  CustomerMessageSendDialog: [
    componentOverrides.CustomerMessageSendDialog,
    { ...componentOverrides.CustomerMessageSendDialog, state: { ...componentOverrides.CustomerMessageSendDialog.state, status: 'success' } },
  ],
  DataAnalysisAdvertisingPanel: [
    componentOverrides.DataAnalysisAdvertisingPanel,
    {
      state: {
        status: 'ready',
        error: null,
        refresh: fixtureFunction('refreshAdvertisingDataReady'),
        data: { finishedAt: '2026-08-20T00:00:00.000Z', statisticsRead: true, metrics: [], campaigns: [{ ...fixtureCampaign, title: '云测广告计划', typeLabel: '按点击', placement: '搜索', strategy: '自动', impressions: 10, clicks: 2, spentCny: 1, acos: 1 }] },
      },
    },
  ],
  DataAnalysisInsightDialog: [
    componentOverrides.DataAnalysisInsightDialog,
    {
      ...componentOverrides.DataAnalysisInsightDialog,
      state: { status: 'idle', error: null },
      modelOptions: [],
      selectedModelId: 'auto',
      modelSelection: null,
    },
  ],
  AccountRemovalPreviewDialog: [
    componentOverrides.AccountRemovalPreviewDialog,
    {
      ...componentOverrides.AccountRemovalPreviewDialog,
      flow: {
        ...componentOverrides.AccountRemovalPreviewDialog.flow,
        stage: 'preview',
        backupReview: { required: true, totalRecords: 1, dataFingerprint: 'data-fingerprint-fixture', domains: [{ domain: 'orders', label: '订单', recordCount: 1 }], latestVerifiedBackup: null },
      },
    },
  ],
  SalesOrderOperationDialog: [
    {
      ...componentOverrides.SalesOrderOperationDialog,
      salesOperation: { open: true, type: 'split', order: fixtureOrder, loading: false, error: null },
      isSplitSalesOperation: true,
      splitOperationOrder: fixtureOrder,
      splitValidation: { valid: true, total: 4, sum: 4, parts: [2, 2] },
      splitPackages: [2, 2],
      operationOrders: [fixtureOrder],
      canSubmitSalesOperation: true,
    },
    {
      ...componentOverrides.SalesOrderOperationDialog,
      salesOperation: { open: true, type: 'cancel', order: fixtureOrder, loading: false, error: null, cancelReasonId: 'reason-fixture', cancelReasonsLoading: false, cancelReasonsError: '', cancelReasons: [{ id: 'reason-fixture', label: '云测取消原因' }] },
      isSplitSalesOperation: false,
      operationOrders: [fixtureOrder],
      canSubmitSalesOperation: true,
    },
  ],
  PurchaseOrdersDialogs: [
    { model: fixtureSharedModelVariant() },
    {
      model: fixtureSharedModelVariant({
        purchaseOperation: {
          open: true,
          type: 'createForecast',
          order: fixtureOrder,
          orders: [fixtureOrder],
          loading: false,
          confirmed: true,
          fields: { orderNumber: 'forecast-fixture', country: 'RU', dataStatus: '1', purchasePlatform: '3', purchaseOrderNo: 'purchase-fixture', logisticsOrder: 'logistics-fixture', packageQty: '1', packageDesc: '云测包裹', remark: '云测备注' },
          cancelReasons: [],
        },
      }),
    },
    {
      model: fixtureSharedModelVariant({
        purchaseOperation: {
          open: true,
          type: 'ozonCancel',
          order: fixtureOrder,
          orders: [fixtureOrder],
          loading: false,
          confirmed: true,
          fields: { cancelReasonId: 'reason-fixture' },
          cancelReasonsLoading: false,
          cancelReasonsError: '',
          cancelReasons: [{ id: 'reason-fixture', label: '云测取消原因' }],
        },
      }),
    },
    {
      model: fixtureSharedModelVariant({
        purchaseOperation: {
          open: true,
          type: 'updatePackage',
          order: fixtureOrder,
          orders: [fixtureOrder],
          loading: false,
          confirmed: true,
          fields: { orderId: 'bus-fixture', purchasePlatform: '3', packageQty: '1', purchaseOrderNo: 'purchase-fixture', logisticsOrder: 'logistics-fixture', packageDesc: '云测包裹' },
          cancelReasons: [],
        },
      }),
    },
    {
      model: fixtureSharedModelVariant({
        manualClassifyDialog: { open: true, order: fixtureOrder, anchorEl: document.body, pendingOption: { value: '待拍单', label: '待拍单' } },
      }),
    },
  ],
  PromptLibraryEditorDialog: [
    componentOverrides.PromptLibraryEditorDialog,
    { ...componentOverrides.PromptLibraryEditorDialog, editorMode: 'create' },
  ],
  PromptLibrarySimpleEditorDialog: [
    { ...componentOverrides.PromptLibrarySimpleEditorDialog, isImageSkill: false, isExternalDataSkill: false, isProfitReviewSkill: false },
    { ...componentOverrides.PromptLibrarySimpleEditorDialog, isImageSkill: true, isExternalDataSkill: false, isProfitReviewSkill: false },
    { ...componentOverrides.PromptLibrarySimpleEditorDialog, editorForm: { ...fixtureEditorForm, imagePositionRules: { main: [], detail: [] } }, isImageSkill: true, isExternalDataSkill: false, isProfitReviewSkill: false },
    { ...componentOverrides.PromptLibrarySimpleEditorDialog, isImageSkill: false, isExternalDataSkill: true, isProfitReviewSkill: false },
    { ...componentOverrides.PromptLibrarySimpleEditorDialog, isImageSkill: false, isExternalDataSkill: false, isProfitReviewSkill: true },
  ],
  PromptLibraryImageGenerationRun: [
    componentOverrides.PromptLibraryImageGenerationRun,
    { ...componentOverrides.PromptLibraryImageGenerationRun, historyOpen: true },
    { ...componentOverrides.PromptLibraryImageGenerationRun, workspaceMode: 'attributes' },
    { ...componentOverrides.PromptLibraryImageGenerationRun, modelOptions: [], textModelOptions: [] },
    {
      ...componentOverrides.PromptLibraryImageGenerationRun,
      selectedPrompt: {
        ...fixturePrompt,
        id: 'installed-image-skill-coverage',
        title: '商品图工作流云测',
        goal: '生成完整商品标题、属性和图片套组',
        body: 'Generate product titles, attributes and images from verified product facts.',
        skillProfile: {
          ...fixturePrompt.skillProfile,
          installType: 'github-skill',
          sourceName: 'ozon-card-optimizer',
          runType: 'api-assisted-readonly',
          usageInputs: ['处理模式', '店铺、市场与语言', '商品、SPU/SKC 与 SKU 信息'],
          apiBindings: [
            { id: 'model.text.generate', label: '文本模型', access: 'read' },
            { id: 'model.image.generate', label: '图片模型', access: 'read' },
            { id: 'product-image-storage', label: '图片安全存储', access: 'read' },
          ],
        },
      },
      values: {
        ...componentOverrides.PromptLibraryImageGenerationRun.values,
        处理模式: 'full-card',
        '店铺、市场与语言': '云测 Ozon 店铺 / 俄罗斯站 / 俄语',
        '商品、SPU/SKC 与 SKU 信息': '云测商品\n货号 offer-fixture\nSKU sku-fixture\n黑色 · 500ml',
      },
      workbench: { modeInputLabel: '处理模式' },
    },
    {
      ...componentOverrides.PromptLibraryImageGenerationRun,
      imagePromptPlan: { main: { status: 'error', message: '云测分析失败', input: { sourceImageIndexes: [0] } }, detail: null },
      imageGeneration: {
        ...componentOverrides.PromptLibraryImageGenerationRun.imageGeneration,
        main: { status: 'partial', message: '云测部分失败', result: { successCount: 0, items: [{ status: 'error', sourceIndex: 0, message: '云测生成失败' }] } },
      },
    },
  ],
  PromptLibraryStandardRun: [
    componentOverrides.PromptLibraryStandardRun,
    { ...componentOverrides.PromptLibraryStandardRun, textModelOptions: [], imageModelOptions: [] },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: { ...fixturePrompt, id: 'ozon-skill-1688-channel-shopdata-get' },
      browserDataEnabled: true,
      operationalWorkflowEnabled: true,
      usageInputs: ['报告内容', '统计范围'],
      values: { 报告内容: 'all', 统计范围: '30' },
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: { ...fixturePrompt, id: 'ozon-product-search', skillProfile: { ...fixturePrompt.skillProfile, runType: 'local-ai-preview' } },
      browserDataEnabled: true,
      usageInputs: ['商品关键词'],
      values: { 商品关键词: '云测商品' },
      draft: { createdAt: '2026-08-20T00:00:00.000Z', result: { status: 'ready', targetProduct: fixtureProduct, productAnalysis: { summary: '云测商品分析' } } },
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: { ...fixturePrompt, id: 'linkfox-seerfar-ozon-market-keyword-search' },
      browserDataEnabled: true,
      externalDataEnabled: true,
      usageInputs: ['关键词'],
      values: { 关键词: '云测关键词' },
      draft: { createdAt: '2026-08-20T00:00:00.000Z', result: { status: 'ready', externalAnalysis: { records: [fixtureRow] } } },
      externalInsight: { status: 'success', report: { title: '云测分析报告', sections: [{ title: '结论', content: '云测通过' }] } },
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: { ...fixturePrompt, id: 'linkfox-seerfar-ozon-market-keyword-search' },
      browserDataEnabled: true,
      externalDataEnabled: true,
      usageInputs: ['关键词'],
      values: { 关键词: '云测关键词' },
      draft: { createdAt: '2026-08-20T00:00:00.000Z', result: { status: 'ready', externalAnalysis: { records: [fixtureRow] } } },
      externalInsight: { status: 'error', message: '云测分析失败' },
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: { ...fixturePrompt, id: 'ozon-ad-analyzer' },
      browserDataEnabled: true,
      performanceAdEnabled: true,
      usageInputs: [],
      values: { performanceAccountId: 'performance-account-fixture', campaignIds: ['campaign-fixture'] },
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: {
        ...fixturePrompt,
        id: 'generic-image-runtime-fixture',
        skillProfile: {
          ...fixturePrompt.skillProfile,
          installType: 'github-skill',
          sourceName: 'generic-image-runtime-fixture',
        },
        toolMeta: {
          apiCapabilityMatch: {
            executionPlan: {
              version: 1,
              steps: [{ id: 'model.text.generate' }, { id: 'model.image.generate' }],
              canStart: true,
              requiresImageExecution: true,
            },
          },
        },
      },
      genericRuntimeEnabled: true,
    },
    {
      ...componentOverrides.PromptLibraryStandardRun,
      selectedPrompt: {
        ...fixturePrompt,
        id: 'bound-shop-product-fixture',
        skillProfile: {
          ...fixturePrompt.skillProfile,
          usageInputs: [
            { key: 'shopContext', label: '店铺市场语言', type: 'text', required: true },
            { key: 'productContext', label: '商品 SPU SKC SKU', type: 'text', required: true },
          ],
        },
      },
      usageInputs: ['店铺市场语言', '商品 SPU SKC SKU'],
      values: { 店铺市场语言: '云测 Ozon 店铺 / 俄罗斯站 / 俄语', '商品 SPU SKC SKU': '商品：云测商品；SKU：sku-fixture' },
      shops: [fixtureShop],
      selectedShop: fixtureShop,
      productSelection: { products: [fixtureProduct], selectedProduct: fixtureProduct, selectedSku: fixtureProduct.skuOptions[0], loading: false, error: '' },
    },
  ],
  CollectionProductListingReadbackStep: [
    componentOverrides.CollectionProductListingReadbackStep,
    { state: { status: 'failed', error: '云测回读失败', operationId: 'preview-fixture', shops: [{ shopId: 'ozon-shop-1', status: 'failed' }], result: { shopResults: [{ result: { results: [{ kind: 'info', response: { readBack: { status: 'pending', importTask: { taskId: 'task-fixture', failed: false } } } }] } }] } } },
    { state: { status: 'completed', error: '', operationId: 'preview-fixture', shops: [{ shopId: 'ozon-shop-1', status: 'completed' }] } },
  ],
};

function getComponentOverrides(modulePath, exportName) {
  return componentOverrides[exportName] || (exportName === 'default' ? componentOverrides[modulePath.split('/').pop()?.replace(/\.jsx$/u, '')] : null) || {};
}

function getComponentOverrideVariants(modulePath, exportName) {
  const componentName = exportName === 'default'
    ? modulePath.split('/').pop()?.replace(/\.jsx$/u, '')
    : exportName;
  return componentOverrideVariants[componentName] || [getComponentOverrides(modulePath, exportName)];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiFixture(url, options = {}) {
  const value = String(url);
  const method = String(options?.method || 'GET').toUpperCase();
  const requestBody = typeof options?.body === 'string' ? options.body : JSON.stringify(options?.body || {});
  stubCalls.push({ method, url: value });
  if (licenseRenewalCoverage && value.includes('/api/auth/login')) return { user: { id: 'license-user-fixture', email: 'v2-cloud@fixture.invalid' } };
  if (licenseRenewalCoverage && value.includes('/api/license/entitlements')) return [{ license_id: 1001, plan_name: '云测店铺月卡', shops: [{ shop_id: 'ozon-shop-1', shop_name: '云测 Ozon 店铺' }] }];
  if (value.includes('/api/app/storage-audit')) return {
    ok: true,
    classificationSummary: {
      registeredTables: 3,
      unclassifiedTables: 0,
      byOwnerScope: { shop: { tables: 1, rows: 1 }, profile: { tables: 1, rows: 1 } },
      byLifecycle: { preserve: { tables: 1, rows: 1 }, rehydrate: { tables: 1, rows: 1 } },
      byBackup: { required: { tables: 1, rows: 1 }, optional: { tables: 1, rows: 1 } },
    },
  };
  if (value.includes('/api/app/data-consistency-audit')) return { ok: true, readyForMigration: true, keys: { duplicateKeyGroups: 0 }, scopes: { emptyShopRows: 0 } };
  if (value.includes('/api/app/database-compaction-preview')) return { ok: true, recommended: true, previewFingerprint: 'compaction-fixture', sqlite: { reclaimableBytes: 1048576 } };
  if (value.includes('/api/ozon/notification-settings')) return {
    ok: true,
    catalog: [
      { domain: 'products', label: '商品', enabled: true },
      { domain: 'orders', label: '订单', enabled: true },
    ],
    rows: [],
  };
  if (value.includes('/api/ozon/notifications/read')) return { ok: true, updated: 1 };
  if (value.includes('/api/ozon/notifications/clear')) return { ok: true, cleared: 1 };
  if (value.includes('/api/ozon/notifications')) return {
    ok: true,
    unread: 1,
    rows: [{
      id: 'notification-fixture',
      domain: 'products',
      eventType: 'product_price_changed',
      offerId: 'offer-fixture',
      shopId: 'ozon-shop-1',
      shopName: '云测 Ozon 店铺',
      oldValue: { name: '云测商品', priceValue: 199, currencyCode: 'RUB' },
      newValue: { name: '云测商品', priceValue: 189, currencyCode: 'RUB' },
      createdAt: '2026-08-20T00:00:00.000Z',
      readAt: null,
    }],
  };
  if (value.includes('/api/app/shop-scope-preview')) return {
    ok: true,
    previewFingerprint: 'scope-fixture',
    totalEmptyRows: 2,
    tables: [
      { table: 'manual_rows', domain: '手工记录', emptyRows: 1, action: 'assign-after-confirmation' },
      { table: 'runtime_rows', domain: '运行记录', emptyRows: 1, action: 'purge-runtime-after-confirmation' },
    ],
  };
  if (value.includes('/api/app/shop-scope-manual-preview')) return {
    ok: true,
    previewFingerprint: 'manual-scope-fixture',
    totalCandidates: 1,
    candidates: [{ id: 'candidate-fixture', table: 'manual_rows', domain: '手工记录', identity: [{ column: 'id', value: 'fixture-1' }] }],
    shops: [fixtureShop],
  };
  if (value.includes('/api/app/technical-retention-preview')) return {
    ok: true,
    previewFingerprint: 'retention-fixture',
    maximumCandidateRows: 1,
    tables: [{ table: 'runtime_trace', candidateRows: 1, maximumCandidateRows: 1, eligibleByAge: 1, eligibleByRowLimit: 0 }],
  };
  if (value.includes('/api/app/profile-maintenance/contracts')) return {
    ok: true,
    commands: { 'rebuild-domain': { targetDomains: ['dashboard'] }, 'release-space': {} },
  };
  if (value.includes('/api/app/profile-maintenance/preview')) {
    if (requestBody.includes('rebuild-domain')) return { ok: true, domain: 'dashboard', humanConfirmationToken: 'domain-confirmation-fixture', targetRows: 1 };
    return {
      ok: true,
      humanConfirmationToken: 'space-confirmation-fixture',
      targetRows: 1,
      targetResources: [{ resourceId: 'dashboard-cache', domain: 'dashboard', table: 'cache_rows', rows: 1 }],
    };
  }
  if (value.includes('/api/app/profile-maintenance/prepare-ticket')) return {
    ok: true,
    domain: 'dashboard',
    trustedSourceTicket: 'trusted-source-ticket-fixture',
    source: 'v2-cloud-stub',
    proofId: 'proof-fixture',
    rowCount: 1,
    rowsSha256: '0'.repeat(64),
  };
  if (value.includes('/api/app/profile-maintenance/confirm')) return { ok: true, domain: 'dashboard', releasedRows: 1 };
  if (value.includes('/api/app/shop-scope-repair/confirm')) return { ok: true, applied: [{ changed: 2 }], deferred: [] };
  if (value.includes('/api/app/shop-scope-manual-resolution/confirm')) return { ok: true, applied: [{ id: 'candidate-fixture' }] };
  if (value.includes('/api/app/technical-retention/confirm')) return { ok: true, active: false, deleted: [{ rows: 1 }] };
  if (value.includes('/api/app/database-compaction/confirm')) return { ok: true, mode: 'completed', reclaimedDatabaseBytes: 1048576 };
  if (value.includes('/api/follow-seller-defense/logins')) return {
    ok: true,
    selectedProfileId: 'follow-login-fixture',
    profiles: [{ id: 'follow-login-fixture', platformName: 'Ozon 前台巡查云测账号', connected: true }],
  };
  if (value.includes('/api/follow-seller-defense/overview')) {
    const baseCase = {
      id: 'follow-case-preview',
      shopId: 'ozon-shop-1',
      productId: 'product-fixture',
      productName: '云测商品',
      offerId: 'offer-fixture',
      sku: 'sku-fixture',
      followCountBefore: 1,
      previewId: 'preview-fixture',
      writePayload: {
        workflow: 'ozon-seller-backend-content-complaint-v2',
        submissionReady: true,
        originalSku: 'sku-fixture',
        followerSkus: ['follower-sku-fixture'],
        sellers: [{ sku: 'follower-sku-fixture', sellerId: 'seller-fixture', sellerName: '云测跟卖商家' }],
        evidence: { files: [{ name: 'evidence.pdf', path: 'C:/fixture/evidence.pdf' }] },
        route: ['商品和价格', '质量监督', '卖家使用我的内容'],
      },
    };
    const cases = [
      { ...baseCase, status: 'preview_ready' },
      { ...baseCase, id: 'follow-case-verification', offerId: 'offer-verification', sku: 'sku-verification', status: 'verification_ready' },
      { ...baseCase, id: 'follow-case-continue', offerId: 'offer-continue', sku: 'sku-continue', status: 'submission_failed', writeResult: { ticketId: 'ticket-fixture' } },
      { ...baseCase, id: 'follow-case-capture-failed', offerId: 'offer-capture-failed', sku: 'sku-capture-failed', status: 'capture_failed', lastErrorCode: 'NETWORK_ERROR' },
    ];
    return { ok: true, cases, patrols: [{ id: 'patrol-fixture', failedCount: 1 }], counts: { total: cases.length, preview_ready: 1, verification_ready: 1, submission_failed: 1, capture_failed: 1 }, pagination: { total: cases.length } };
  }
  if (method === 'POST' && /\/api\/follow-seller-defense\/patrols(?:\?|$)/u.test(value)) return new Promise(() => {});
  if (value.includes('/api/follow-seller-defense/')) return { ok: true, cases: [], updatedCases: [], patrols: [], counts: { total: 0 } };
  if (value.includes('/api/shops')) return { ok: true, shops: [fixtureShop], rows: [fixtureShop], total: 1 };
  if (value.includes('/api/model-api/accounts')) return {
    ok: true,
    accounts: [{
      id: 'model-account-fixture', apiAlias: '云测图片接口', name: '云测模型账户', provider: 'codesonline', enabled: true,
      websiteUrl: 'https://fixture.invalid/model-login', loginAccount: 'model-user', hasLoginPassword: true,
      baseUrl: 'https://fixture.invalid/v1', hasApiKey: true, defaultModel: 'fixture-image-model', usageScene: '文生图',
      availableModels: [{ id: 'fixture-image-model', label: '云测图片模型', capabilities: ['image-generation'], options: { quality: [{ id: 'high', label: '高清' }, { id: 'draft', label: '草稿' }], style: [{ id: 'product', label: '商品图' }] } }],
      capabilities: ['image-generation'], discoveryVerified: true, quality: 'high', style: 'product', isDefault: true,
    }],
    rows: [], total: 1,
  };
  if (value.includes('/api/integrations/seerfar/category-tree')) return {
    ok: true,
    nodes: [
      { id: '1234', title: '云测父类目', pathText: '云测父类目', hasChildren: true },
      { id: '1235', title: '云测叶子类目', pathText: '云测叶子类目', hasChildren: false },
    ],
  };
  if (value.includes('/api/performance/accounts')) return {
    ok: true,
    accounts: [
      { id: 'performance-account-fixture', accountId: 'performance-account-fixture', shopId: 'ozon-shop-1', shopName: '云测 Ozon 店铺', title: '云测推广接口', clientIdMasked: 'fixture-client', hasClientId: true, hasClientSecret: true, configured: true, enabled: true, status: 'connected', values: { shopId: 'ozon-shop-1', performanceClientId: 'fixture-client' } },
      { id: 'performance-account-fixture-2', accountId: 'performance-account-fixture-2', shopId: 'ozon-shop-1', shopName: '云测 Ozon 店铺', title: '云测备用推广接口', clientIdMasked: 'fixture-client-2', hasClientId: true, hasClientSecret: true, configured: true, enabled: true, status: 'connected', values: { shopId: 'ozon-shop-1', performanceClientId: 'fixture-client-2' } },
    ],
    rows: [],
    total: 1,
  };
  if (value.includes('/api/performance/overview')) return {
    ok: true,
    source: 'v2-cloud-stub',
    campaigns: [{
      ...fixtureCampaign,
      id: 'campaign-fixture',
      title: '云测广告计划',
      type: '按点击收费的商品计划',
      statusLabel: '运行中',
      detailRead: { products: true, objects: true, bidInsights: true },
      productCount: 1,
      products: [{ ...fixtureRow, sku: 'sku-fixture', title: '云测商品', statusLabel: '可投放', campaignTitles: ['云测广告计划'], bid: 10 }],
      objects: [{ ...fixtureRow, id: 'object-fixture', title: '云测推广对象' }],
      statistics: { dailyTrend: [{ date: '2026-08-19', spend: 10, clicks: 2, orders: 1, sales: 199 }] },
    }],
    products: [{ ...fixtureRow, sku: 'sku-fixture', title: '云测商品', statusLabel: '可投放', campaignTitles: ['云测广告计划'], bid: 10 }],
    objects: [{ ...fixtureRow, id: 'object-fixture', title: '云测推广对象' }],
    campaignProductStats: [fixtureCampaign],
    dataSets: {},
    notifications: { recorded: 0 },
  };
  if (value.includes('/api/performance/products')) return { ok: true, products: [{ ...fixtureRow, sku: 'sku-fixture', title: '云测商品', statusLabel: '可投放', campaignTitles: [] }], rows: [], total: 160, hasNext: true };
  if (value.includes('/api/points/ledger')) return { ok: true, ledger: [{ id: 'ledger-fixture', amount: 100, balance: 1000, type: 'grant', createdAt: '2026-08-20T00:00:00.000Z' }], rows: [], total: 1 };
  if (value.includes('/api/points/packages')) return { ok: true, packages: [{ id: 'points-package-fixture', name: '云测点数包', points: 1000, price: 1, featured: true }], rows: [], total: 1 };
  if (value.includes('/api/points/wallet')) return { ok: true, balance: 1000, available: 1000, rows: [], total: 1 };
  if (value.includes('/api/model-presets')) return { ok: true, presets: [{ id: 'preset-fixture', name: '云测默认模型', model: 'fixture-model' }], rows: [], total: 1 };
  if (value.includes('/api/cache/dashboard-business-share')) {
    return {
      ok: true,
      source: 'v2-cloud-stub',
      counts: { salesOrderCount: 0, pendingPurchaseCount: 0, afterSalesTodoCount: 0, stockWarningCount: 0 },
    };
  }
  if (value.includes('/api/cache/data-analysis')) {
    return {
      ok: true,
      source: 'v2-cloud-stub',
      rows: [fixtureRow],
      total: 1,
      data: {
        campaigns: [fixtureCampaign],
        marketingStats: [fixtureCampaign],
        trend: [{ date: '2026-08-19', metrics: [{ key: 'sales', value: 199 }] }],
        sources: [{ source: 'ozon', label: 'Ozon', value: 1 }],
        statisticsRead: true,
      },
    };
  }
  if (value.includes('/api/cache/marketing')) {
    return { ok: true, source: 'v2-cloud-stub', rows: [fixtureCampaign], items: [fixtureCampaign], campaigns: [fixtureCampaign], total: 1, data: { rows: [fixtureCampaign], campaigns: [fixtureCampaign] } };
  }
  if (value.includes('/api/cache/products')) return { ok: true, source: 'v2-cloud-stub', rows: [fixtureProduct], products: [fixtureProduct], items: [fixtureProduct], total: 1 };
  if (value.includes('/api/cache/orders') || value.includes('/api/cache/returns')) return { ok: true, source: 'v2-cloud-stub', rows: [fixtureOrder], orders: [fixtureOrder], items: [fixtureOrder], total: 1 };
  if (value.includes('/api/cache/')) return { ok: true, source: 'v2-cloud-stub', rows: [fixtureRow], items: [fixtureRow], total: 1, data: { rows: [fixtureRow], items: [fixtureRow] } };
  if (value.includes('/api/sync/')) return { ok: true, accepted: true, jobId: 'v2-cloud-stub', status: 'completed' };
  if (value.includes('/api/protected-compute/')) return { ok: true, capabilities: [], contracts: [] };
  if (value.includes('/api/points/')) return { ok: true, balance: 1000, packages: [], rows: [], total: 0 };
  if (value.includes('/api/store/plans')) return { ok: true, plans: [] };
  if (value.includes('/local-data-api/')) return { ok: true, data: {} };
  return { ok: true, rows: [], total: 0, result: {}, data: {}, task: { status: 'completed' } };
}

function visible(element) {
  if (!element?.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  const style = globalThis.getComputedStyle?.(element);
  return style?.display !== 'none' && style?.visibility !== 'hidden';
}

function mark(element, status = 'passed', error = '') {
  const sourceId = String(element?.getAttribute?.('data-v2-source-id') || '').trim();
  if (!sourceId) return;
  const current = passed.get(sourceId);
  if (current?.status === 'passed') return;
  passed.set(sourceId, {
    sourceId,
    status,
    tag: element.tagName?.toLowerCase() || '',
    label: String(element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 160),
    error,
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function pageButton(label) {
  return [...document.querySelectorAll('.subnav-item, .nav-item, button, [role="button"]')]
    .find((node) => String(node.textContent || '').replace(/\s+/gu, ' ').trim() === label)
    || [...document.querySelectorAll('.subnav-item, .nav-item, button, [role="button"]')]
      .find((node) => String(node.textContent || '').includes(label));
}

function controlLabel(element) {
  return String(
    element?.getAttribute?.('aria-label')
      || element?.textContent
      || element?.getAttribute?.('title')
      || '',
  ).replace(/\s+/gu, ' ').trim();
}

function isCloseAction(element) {
  return /^(?:取消|关闭|返回|最小化|暂不处理)/u.test(controlLabel(element));
}

async function prepareField(element) {
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute('type') || '').toLowerCase();
  if (tag === 'select') {
    const option = [...element.options].find((item) => !item.disabled && item.value);
    if (option) fireEvent.change(element, { target: { value: option.value } });
    return;
  }
  if (tag === 'textarea' || tag === 'input') {
    if (['checkbox', 'radio'].includes(type)) fireEvent.click(element);
    else if (!['button', 'submit', 'file', 'hidden'].includes(type)) {
      const placeholder = String(element.getAttribute('placeholder') || element.getAttribute('aria-label') || '');
      const value = type === 'email' || /邮箱/u.test(placeholder)
        ? 'v2-cloud@fixture.invalid'
        : /卡密/u.test(placeholder)
          ? 'AAAA-BBBB-CCCC-DDDD'
          : /HTTPS 图片地址/iu.test(placeholder)
            ? 'https://fixture.invalid/added-image.webp'
            : type === 'number'
        ? '1'
        : type === 'date'
          ? '2026-08-20'
          : type === 'password'
            ? 'V2云端测试专用口令123456'
            : 'V2 云端测试';
      fireEvent.change(element, { target: { value } });
    }
  }
}

async function crawlSkuEditorCombobox(pageLabel) {
  const combos = [...document.querySelectorAll('[role="combobox"], .MuiSelect-select')]
    .filter(visible)
    .filter((combo) => /正在编辑的 SKU/u.test(String(combo.closest('.MuiFormControl-root')?.textContent || '')));
  for (const combo of combos) {
    try {
      fireEvent.mouseDown(combo);
      await settle();
      const option = [...document.querySelectorAll('[role="option"][data-v2-source-id], .MuiMenuItem-root[data-v2-source-id]')]
        .filter(visible)
        .find((item) => /^\s*\d+\./u.test(String(item.textContent || '')));
      if (!option) continue;
      const sourceId = option.getAttribute('data-v2-source-id');
      fireEvent.click(option);
      mark(option);
      reportProgress(`sku-option ${pageLabel} ${sourceId}`);
      await settle();
    } catch (error) {
      stubCalls.push({ method: 'SKU_EDITOR_OPTION_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
    }
  }
}

async function crawlEditDialogPrevious(pageLabel) {
  if (!pageLabel.includes('CollectionProductEditDialog')) return;
  try {
    let previous = [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => String(button.textContent || '').replace(/\s+/gu, '').includes('上一步'));
    if (!previous) {
      const next = [...document.querySelectorAll('button[data-v2-source-id]')]
        .filter(visible)
        .find((button) => String(button.textContent || '').replace(/\s+/gu, '').includes('下一步'));
      if (next) {
        fireEvent.click(next);
        await settle();
        previous = [...document.querySelectorAll('button[data-v2-source-id]')]
          .filter(visible)
          .find((button) => String(button.textContent || '').replace(/\s+/gu, '').includes('上一步'));
      }
    }
    if (!previous) return;
    fireEvent.click(previous);
    mark(previous);
    reportProgress(`edit-previous ${pageLabel} ${previous.getAttribute('data-v2-source-id')}`);
    await settle();
  } catch (error) {
    stubCalls.push({ method: 'EDIT_PREVIOUS_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlLicenseRenewal(pageLabel) {
  if (!pageLabel.includes('DesktopAccessGate')) return;
  try {
    // Generic control walking can submit after the email field but before the
    // password field. Fill the real login form as one transaction so the
    // expired-license response can expose the production renewal selector.
    const email = document.querySelector('input[type="email"]');
    const password = document.querySelector('input[type="password"]');
    const form = email?.closest('form');
    const submit = form?.querySelector('button[type="submit"][data-v2-source-id]');
    if (email && password && submit && !submit.disabled) {
      fireEvent.change(email, { target: { value: 'v2-cloud@fixture.invalid' } });
      fireEvent.change(password, { target: { value: 'V2CloudPassword123!' } });
      fireEvent.click(submit);
      mark(submit);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await settle();
        if ([...document.querySelectorAll('[role="combobox"], .MuiSelect-select')]
          .some((item) => visible(item) && /续费店铺/u.test(String(item.closest('.MuiFormControl-root')?.textContent || '')))) break;
      }
    }

    const renewalCombo = [...document.querySelectorAll('[role="combobox"], .MuiSelect-select')]
      .filter(visible)
      .find((item) => /续费店铺/u.test(String(item.closest('.MuiFormControl-root')?.textContent || '')));
    if (!renewalCombo) return;
    fireEvent.mouseDown(renewalCombo);
    await settle();
    const option = [...document.querySelectorAll('[role="option"][data-v2-source-id], .MuiMenuItem-root[data-v2-source-id]')]
      .filter(visible)
      .find((item) => /云测 Ozon 店铺|云测店铺月卡/u.test(String(item.textContent || '')));
    if (!option) return;
    const sourceId = option.getAttribute('data-v2-source-id');
    fireEvent.click(option);
    mark(option);
    reportProgress(`license-renewal ${pageLabel} ${sourceId}`);
    await settle();
  } catch (error) {
    stubCalls.push({ method: 'LICENSE_RENEWAL_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlOzonBrowserWaiting(pageLabel) {
  if (!pageLabel.includes('OzonBrowserLoginPanel')) return;
  try {
    const login = [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => /打开 Ozon 登录|重新登录/u.test(String(button.textContent || '')));
    if (login) {
      fireEvent.click(login);
      mark(login);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await settle();
        if ([...document.querySelectorAll('button[data-v2-source-id]')]
          .some((button) => visible(button) && /重新显示登录窗口/u.test(String(button.textContent || '')))) break;
      }
    }

    const reveal = [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => /重新显示登录窗口/u.test(String(button.textContent || '')));
    if (reveal) {
      fireEvent.click(reveal);
      mark(reveal);
      await settle();
    }
    const cancel = [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => /取消等待/u.test(String(button.textContent || '')));
    if (cancel) {
      fireEvent.click(cancel);
      mark(cancel);
      await settle();
    }
  } catch (error) {
    stubCalls.push({ method: 'OZON_BROWSER_WAITING_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlAdditionalShopCard(pageLabel) {
  if (!pageLabel.includes('ShopSettingsDialog')) return;
  const openDialog = async () => {
    const add = [...document.querySelectorAll('.shop-list-card button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => String(button.textContent || '').trim() === '新增');
    if (!add) return null;
    fireEvent.click(add);
    mark(add);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await settle();
      const dialog = document.querySelector('#additional-shop-card-title')?.closest('[role="dialog"]');
      if (dialog) return dialog;
    }
    return null;
  };

  try {
    let dialog = await openDialog();
    if (dialog) {
      const cancel = [...dialog.querySelectorAll('button[data-v2-source-id]')]
        .find((button) => String(button.textContent || '').trim() === '取消');
      if (cancel) {
        fireEvent.click(cancel);
        mark(cancel);
        await settle();
      }
    }

    dialog = await openDialog();
    if (dialog) {
      const input = dialog.querySelector('input');
      if (input) fireEvent.change(input, { target: { value: 'AAAA-BBBB-CCCC-DDDD' } });
      const submit = [...dialog.querySelectorAll('button[data-v2-source-id]')]
        .find((button) => /验证卡密并新增/u.test(String(button.textContent || '')));
      if (submit) {
        fireEvent.click(submit);
        mark(submit);
        await settle();
      }
    }
  } catch (error) {
    stubCalls.push({ method: 'ADDITIONAL_SHOP_CARD_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlFollowSellerSelectionPair(pageLabel) {
  if (!pageLabel.includes('FollowSellerDefensePage')) return;
  const selectAll = [...document.querySelectorAll('button[data-v2-source-id]')]
    .filter(visible)
    .find((button) => String(button.textContent || '').trim() === '全选');
  if (!selectAll) return;
  fireEvent.click(selectAll);
  mark(selectAll);
  await settle();
  const cancelAll = [...document.querySelectorAll('button[data-v2-source-id]')]
    .filter(visible)
    .find((button) => String(button.textContent || '').trim() === '取消全选');
  if (!cancelAll) return;
  fireEvent.click(cancelAll);
  mark(cancelAll);
  await settle();
}

async function crawlPromptQuickRunActions(pageLabel, options = {}) {
  if (!pageLabel.includes('PromptLibraryQuickRunPanel')) return;
  const clickAndMark = async (element) => {
    if (!element || !visible(element)) return false;
    fireEvent.click(element);
    mark(element);
    await settle();
    return true;
  };

  await clickAndMark(document.querySelector('button.prompt-library-image-mode-switch-button[data-v2-source-id]'));
  const history = document.querySelector('button.prompt-library-image-history-button[data-v2-source-id]');
  if (await clickAndMark(history)) {
    const historyClose = [...document.querySelectorAll('.prompt-library-image-history-dialog .MuiDialogActions-root button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => String(button.textContent || '').trim() === '关闭');
    await clickAndMark(historyClose);
  }
  const clearDraft = [...document.querySelectorAll('.MuiDialogActions-root button[data-v2-source-id]')]
    .filter(visible)
    .find((button) => String(button.textContent || '').trim() === '清空预览');
  await clickAndMark(clearDraft);

  const close = options.preferCloseActions
    ? document.querySelector('button[aria-label="关闭使用功能"][data-v2-source-id]')
    : [...document.querySelectorAll('.MuiDialogActions-root button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => String(button.textContent || '').trim() === '关闭');
  await clickAndMark(close);
}

async function crawlPurchaseBrowserQuickPreset(pageLabel) {
  if (!pageLabel.includes('PurchaseBrowserQuickActions')) return;
  try {
    const openButton = document.querySelector('button[aria-label="打开内置浏览器"][data-v2-source-id]');
    if (!openButton || !visible(openButton)) return;
    fireEvent.click(openButton);
    mark(openButton);
    await settle();
    const preset = [...document.querySelectorAll('[role="menuitem"][data-v2-source-id]')]
      .filter(visible)
      .find((item) => !item.disabled);
    if (!preset) return;
    fireEvent.click(preset);
    mark(preset);
    await settle();
  } catch (error) {
    stubCalls.push({ method: 'PURCHASE_BROWSER_PRESET_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlPromptLibraryModelAndModeOptions(pageLabel) {
  if (!pageLabel.includes('PromptLibraryImageGenerationRun') && !pageLabel.includes('PromptLibraryStandardRun')) return;
  const labels = pageLabel.includes('PromptLibraryImageGenerationRun')
    ? ['处理模式', '分析 / 文案模型', '图片生成模型', '输出尺寸', '生成质量']
    : ['执行模型', '分析模型', '分析 / 文案模型', '图片处理模型', '图片生成模型'];
  for (const label of labels) {
    try {
      const combo = [...document.querySelectorAll('[role="combobox"], .MuiSelect-select')]
        .filter(visible)
        .find((item) => {
          const form = item.closest('.MuiFormControl-root');
          const fieldLabel = String(form?.querySelector('label')?.textContent || '').replace(/\s+/gu, ' ').trim();
          return fieldLabel === label;
        });
      if (!combo || combo.getAttribute('aria-disabled') === 'true') continue;
      fireEvent.mouseDown(combo);
      await settle();
      const option = [...document.querySelectorAll('[role="option"][data-v2-source-id], .MuiMenuItem-root[data-v2-source-id]')]
        .filter(visible)
        .find((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
      if (!option) {
        fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
        continue;
      }
      fireEvent.click(option);
      mark(option);
      await settle();
    } catch (error) {
      stubCalls.push({ method: 'PROMPT_SELECT_OPTION_SKIPPED', url: `${pageLabel}|${label}`, error: String(error?.message || error).slice(0, 300) });
    }
  }
}

async function crawlSeerfarCategoryPicker(pageLabel) {
  if (!pageLabel.includes('PromptLibrarySeerfarCategoryPicker')) return;
  const input = document.querySelector('input');
  if (!input) return;
  try {
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(input);
    await new Promise((resolve) => setTimeout(resolve, 260));
    await settle();

    const back = () => [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => /返回上一级类目/u.test(String(button.getAttribute('aria-label') || button.textContent || '')));
    const choose = () => [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => String(button.textContent || '').trim() === '选择');

    const firstOption = document.querySelector('.prompt-library-seerfar-category-option[role="button"]');
    if (firstOption) {
      fireEvent.click(firstOption);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await settle();
      const backButton = back();
      if (backButton) {
        fireEvent.click(backButton);
        mark(backButton);
        await settle();
      }
    }

    fireEvent.click(input);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const chooseButton = choose();
    if (chooseButton) {
      fireEvent.click(chooseButton);
      mark(chooseButton);
      await settle();
    }

    fireEvent.change(input, { target: { value: '1234' } });
    fireEvent.click(input);
    await settle();
    const manual = [...document.querySelectorAll('button[data-v2-source-id]')]
      .filter(visible)
      .find((button) => /使用这个 ID/u.test(String(button.textContent || '')));
    if (manual) {
      fireEvent.click(manual);
      mark(manual);
      await settle();
    }
  } catch (error) {
    stubCalls.push({ method: 'SEERFAR_CATEGORY_STATE_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
  }
}

async function crawlNewlyEnabledNearbyActions(field, pageLabel) {
  let container = field?.parentElement || null;
  for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
    const buttons = [...container.querySelectorAll('button[data-v2-source-id], [role="button"][data-v2-source-id]')]
      .filter(visible)
      .filter((button) => button.getAttribute('role') !== 'tab')
      .filter((button) => !isCloseAction(button))
      .filter((button) => passed.get(button.getAttribute('data-v2-source-id'))?.status !== 'passed');
    if (!buttons.length) continue;
    for (const button of buttons) {
      if (!button.isConnected || button.disabled) continue;
      const sourceId = button.getAttribute('data-v2-source-id');
      try {
        reportProgress(`nearby-action ${pageLabel} ${sourceId}`);
        fireEvent.click(button);
        mark(button);
        await settle();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        mark(button, 'failed', message);
        failures.push({ page: pageLabel, sourceId, message });
      }
    }
    break;
  }
}

async function crawlComboboxOptions(pageLabel) {
  const combos = [...document.querySelectorAll('[role="combobox"], .MuiSelect-select')].filter(visible);
  reportProgress(`comboboxes ${pageLabel} ${combos.length}`);
  for (const combo of combos) {
    if (!combo.isConnected || combo.getAttribute('aria-disabled') === 'true') continue;
    for (let optionPass = 0; optionPass < 30; optionPass += 1) {
      try {
        fireEvent.mouseDown(combo);
        await settle();
      } catch {
        break;
      }
      const option = [...document.querySelectorAll('[role="option"][data-v2-source-id], .MuiMenuItem-root[data-v2-source-id]')]
        .filter(visible)
        .find((item) => passed.get(item.getAttribute('data-v2-source-id'))?.status !== 'passed');
      reportProgress(`combobox-options ${pageLabel} ${document.querySelectorAll('[role="option"][data-v2-source-id], .MuiMenuItem-root[data-v2-source-id]').length}`);
      if (!option) {
        fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
        break;
      }
      const sourceId = option.getAttribute('data-v2-source-id');
      try {
        reportProgress(`option ${pageLabel} ${sourceId}`);
        fireEvent.click(option);
        mark(option);
        await settle();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        mark(option, 'failed', message);
        failures.push({ page: pageLabel, sourceId, message });
      }
      if (!combo.isConnected) break;
    }
  }
}

async function crawlVisibleInstrumentedControls(pageLabel, {
  allowPassedActions = false,
  preferCommit = false,
  preferCloseActions = false,
  skipCloseActions = false,
  skipTabs = false,
} = {}) {
  const elements = [...document.querySelectorAll('[data-v2-source-id]')]
    .filter(visible)
    .filter((element) => !skipTabs || element.getAttribute('role') !== 'tab')
    .filter((element) => !skipCloseActions || !isCloseAction(element))
    .sort((left, right) => {
      const closePattern = /^(?:取消|关闭|返回|最小化|暂不处理)/u;
      if (preferCloseActions) {
        const leftClose = closePattern.test(controlLabel(left)) ? 1 : 0;
        const rightClose = closePattern.test(controlLabel(right)) ? 1 : 0;
        if (leftClose !== rightClose) return rightClose - leftClose;
      }
      const riskPattern = /(?:投诉|提交|上传|删除|清理|释放|重建|压缩|写入|上架|退款|发货|巡查全店|方案\s*[12])/u;
      const leftRisk = riskPattern.test(String(left.textContent || '').trim()) ? 1 : 0;
      const rightRisk = riskPattern.test(String(right.textContent || '').trim()) ? 1 : 0;
      if (leftRisk !== rightRisk) return leftRisk - rightRisk;
      if (!preferCommit) return 0;
      const leftClose = closePattern.test(controlLabel(left)) ? 1 : 0;
      const rightClose = closePattern.test(controlLabel(right)) ? 1 : 0;
      return leftClose - rightClose;
    });
  let attempted = 0;
  for (const element of elements) {
    const sourceId = element.getAttribute('data-v2-source-id');
    if (
      !visible(element)
      || ((!allowPassedActions || isCloseAction(element)) && passed.get(sourceId)?.status === 'passed')
    ) continue;
    const fastAsyncAction = (pageLabel.includes('PaidPromotionPage') || pageLabel === '付费推广')
      && element.tagName.toLowerCase() === 'button';
    attempted += 1;
    try {
      reportProgress(`control ${pageLabel} ${sourceId}`);
      const tag = element.tagName.toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) {
        await prepareField(element);
        await settle();
        await crawlNewlyEnabledNearbyActions(element, pageLabel);
      }
      else {
        const nestedField = element.querySelector?.('input:not([type="hidden"]), textarea, select');
        const combo = element.matches?.('[role="combobox"], .MuiSelect-select')
          ? element
          : element.querySelector?.('[role="combobox"], .MuiSelect-select');
        if (nestedField && !combo) {
          await prepareField(nestedField);
          await settle();
          await crawlNewlyEnabledNearbyActions(nestedField, pageLabel);
        }
        else if (fastAsyncAction) element.click();
        else if (combo) fireEvent.mouseDown(combo);
        else fireEvent.click(element);
      }
      reportProgress(`control-dispatched ${pageLabel} ${sourceId}`);
      mark(element);
      if (fastAsyncAction) {
        // Paid promotion performs long asynchronous readbacks after real button
        // clicks. Yield one task so React can expose the next production state,
        // but do not await the write/readback promise in the cloud write-stub run.
        await new Promise((resolve) => setTimeout(resolve, 0));
        reportProgress(`control-fast-settled ${pageLabel} ${sourceId}`);
        continue;
      }
      await settle();
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      mark(element, 'failed', message);
      failures.push({ page: pageLabel, sourceId, message });
    }
  }
  return attempted;
}

async function crawlPaidPromotionWriteDialogs(pageLabel) {
  if (!pageLabel.includes('PaidPromotionPage')) return;
  const actionLabels = [
    '创建计划',
    '编辑',
    '加商品',
    '移除',
    '改预算',
    '调出价',
    '搜索出价',
    '删搜索价',
    '搜推启停',
  ];
  for (const actionLabel of actionLabels) {
    const existingDialog = document.querySelector('.paid-promotion-write-dialog[role="dialog"], .paid-promotion-write-dialog .MuiDialog-paper');
    const existingCancel = existingDialog
      ? [...existingDialog.querySelectorAll('button')].find((button) => String(button.textContent || '').trim() === '取消')
      : null;
    if (existingCancel && visible(existingCancel)) {
      existingCancel.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const action = [...document.querySelectorAll('button')]
      .filter(visible)
      .find((button) => String(button.textContent || '').replace(/\s+/gu, ' ').trim() === actionLabel);
    if (!action) continue;
    reportProgress(`paid-dialog ${pageLabel} ${actionLabel}`);
    action.click();
    mark(action);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = document.querySelector('.paid-promotion-write-dialog[role="dialog"], .paid-promotion-write-dialog .MuiDialog-paper');
    if (!dialog) continue;
    await crawlComboboxOptions(pageLabel);

    // Candidate selection buttons are only enabled after the production dialog
    // has consumed the stubbed product response. Exercise them in-place without
    // committing a real external write.
    for (const label of ['搜索', '选中/取消当前展示', '加载更多', '选中/取消全部计划商品']) {
      const button = [...dialog.querySelectorAll('button')]
        .filter(visible)
        .find((item) => String(item.textContent || '').replace(/\s+/gu, ' ').trim() === label);
      if (!button) continue;
      button.click();
      mark(button);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const cancel = [...dialog.querySelectorAll('button')]
      .filter(visible)
      .find((button) => String(button.textContent || '').trim() === '取消');
    if (cancel) {
      cancel.click();
      mark(cancel);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function crawlTabStates(pageLabel, options = {}) {
  const visited = new Set();
  const visit = async (tab, blockedTabLists = new Set()) => {
    if (!tab.isConnected || tab.getAttribute('aria-disabled') === 'true') return;
    const sourceId = String(tab.getAttribute('data-v2-source-id') || '');
    const signature = sourceId || `${String(tab.textContent || '').trim()}|${String(tab.getAttribute('value') || '')}`;
    if (visited.has(signature)) return;
    visited.add(signature);
    const tabList = tab.closest('[role="tablist"]');
    try {
      const tabLabel = String(tab.textContent || '').trim();
      const fastTabDispatch = /^推广订单$/u.test(tabLabel)
        || pageLabel.includes('PaidPromotionPage')
        || pageLabel === '付费推广';
      reportProgress(`tab ${pageLabel} ${tabLabel}`);
      if (fastTabDispatch) tab.click();
      else fireEvent.click(tab);
      mark(tab);
      if (fastTabDispatch) await new Promise((resolve) => setTimeout(resolve, 0));
      else await settle();
      await crawlFollowSellerSelectionPair(pageLabel);
      if (options.preferCloseActions) {
        await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true });
      }
      await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
      await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
      await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, preferCommit: true, skipCloseActions: true });
      if (!pageLabel.includes('PaidPromotionPage') && pageLabel !== '付费推广') {
        await crawlUninstrumentedFields(pageLabel, new Set());
      }
      await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
      if (!pageLabel.includes('PaidPromotionPage') && pageLabel !== '付费推广') {
        await crawlComboboxOptions(pageLabel);
      }
      const nestedTabs = [...document.querySelectorAll('[role="tab"]')]
        .filter(visible)
        .filter((item) => {
          const nestedList = item.closest('[role="tablist"]');
          return nestedList !== tabList && !blockedTabLists.has(nestedList);
        });
      const nextBlocked = new Set(blockedTabLists);
      if (tabList) nextBlocked.add(tabList);
      for (const nestedTab of nestedTabs) await visit(nestedTab, nextBlocked);
    } catch (error) {
      stubCalls.push({ method: 'TAB_STATE_SKIPPED', url: `${pageLabel}|${String(tab.textContent || '').trim()}`, error: String(error?.message || error).slice(0, 300) });
    }
  };
  const tabs = [...document.querySelectorAll('[role="tab"]')].filter(visible);
  for (const tab of tabs) {
    await visit(tab);
  }
}

async function crawlUninstrumentedButtons(pageLabel, primedActions) {
  const buttons = [...document.querySelectorAll('button:not([data-v2-source-id]), [role="button"]:not([data-v2-source-id])')]
    .filter(visible)
    .filter((button) => !button.closest('.nav-item, .subnav-item, .app-sidebar, [data-v2-source-id]'));
  for (const button of buttons) {
    if (!button.isConnected) continue;
    const label = String(button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/gu, ' ').trim();
    const signature = `${pageLabel}|${button.getAttribute('role') || button.tagName}|${label}|${button.className || ''}`;
    if (!label || primedActions.has(signature)) continue;
    primedActions.add(signature);
    try {
      reportProgress(`prime ${pageLabel} ${label.slice(0, 80)}`);
      fireEvent.click(button);
      await settle();
      await crawlComboboxOptions(pageLabel);
      await crawlVisibleInstrumentedControls(pageLabel, { skipCloseActions: true });
    } catch (error) {
      stubCalls.push({ method: 'UNINSTRUMENTED_CONTROL_SKIPPED', url: signature, error: String(error?.message || error).slice(0, 300) });
    }
  }
}

async function crawlUninstrumentedFields(pageLabel, primedFields) {
  const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
    .filter(visible)
    .filter((field) => !field.closest('[data-v2-source-id]'));
  for (const field of fields) {
    const signature = `${pageLabel}|${field.tagName}|${field.getAttribute('name') || ''}|${field.getAttribute('placeholder') || ''}|${field.getAttribute('aria-label') || ''}`;
    if (primedFields.has(signature)) continue;
    primedFields.add(signature);
    try {
      await prepareField(field);
      await settle();
      await crawlNewlyEnabledNearbyActions(field, pageLabel);
    } catch (error) {
      stubCalls.push({ method: 'UNINSTRUMENTED_FIELD_SKIPPED', url: signature, error: String(error?.message || error).slice(0, 300) });
    }
  }
}

async function crawlImageContextMenus(pageLabel) {
  const tiles = [...document.querySelectorAll('.prompt-library-image-comparison-tile')].filter(visible);
  for (const tile of tiles) {
    try {
      fireEvent.contextMenu(tile, { clientX: 40, clientY: 40 });
      await settle();
      await crawlVisibleInstrumentedControls(pageLabel, { skipTabs: true, skipCloseActions: true });
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    } catch (error) {
      stubCalls.push({ method: 'CONTEXT_MENU_SKIPPED', url: pageLabel, error: String(error?.message || error).slice(0, 300) });
    }
  }
}

async function crawlImageFailureStates(pageLabel) {
  const images = [...document.querySelectorAll('img')].filter(visible);
  if (!images.length) return;
  for (const item of images) fireEvent.error(item);
  await settle();
  await crawlVisibleInstrumentedControls(pageLabel, { skipTabs: true, skipCloseActions: true });
}

async function crawlCurrentPage(pageLabel, options = {}) {
  currentCrawlPageLabel = pageLabel;
  const primedActions = new Set();
  const primedFields = new Set();
  const maxPasses = Math.max(1, Number(options.maxPasses) || 5);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (options.preferCloseActions) {
      await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true });
    }
    // The paid-promotion operation buttons live on the initial plan tab. Open
    // every write-dialog state before generic tab traversal moves to reports.
    await crawlPaidPromotionWriteDialogs(pageLabel);
    await crawlLicenseRenewal(pageLabel);
    await crawlOzonBrowserWaiting(pageLabel);
    await crawlAdditionalShopCard(pageLabel);
    await crawlFollowSellerSelectionPair(pageLabel);
    await crawlPromptQuickRunActions(pageLabel, options);
    if (pass === 0) {
      await crawlPurchaseBrowserQuickPreset(pageLabel);
      await crawlPromptLibraryModelAndModeOptions(pageLabel);
      // Select options are portaled by MUI and may disappear after a nearby run
      // or close action. Exercise them before generic button traversal mutates
      // the production component state.
      await crawlComboboxOptions(pageLabel);
    }
    // Exercise the component's supplied initial state before tab traversal moves it
    // elsewhere. Two passes allow selection/field changes to unlock adjacent actions.
    await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
    await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
    await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, preferCommit: true, skipCloseActions: true });
    await crawlUninstrumentedFields(pageLabel, primedFields);
    await crawlVisibleInstrumentedControls(pageLabel, { ...options, skipTabs: true, skipCloseActions: true });
    await crawlUninstrumentedButtons(pageLabel, primedActions);
    await crawlImageContextMenus(pageLabel);
    await crawlImageFailureStates(pageLabel);
    await crawlEditDialogPrevious(pageLabel);
    await crawlSeerfarCategoryPicker(pageLabel);
    await crawlTabStates(pageLabel, options);
    await crawlSkuEditorCombobox(pageLabel);
    await crawlComboboxOptions(pageLabel);
    const attempted = await crawlVisibleInstrumentedControls(pageLabel, options);
    if (!attempted) break;
  }
}

function renderApp() {
  return render(
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <App />
    </ThemeProvider>,
  );
}

function renderComponent(Component, modulePath = '', exportName = '', overrides = null) {
  const resolvedOverrides = overrides || getComponentOverrides(modulePath, exportName);
  const baseProps = COMPONENT_OVERRIDE_ONLY_EXPORTS.has(exportName) ? {} : fixtureProps;
  const component = <Component {...baseProps} {...resolvedOverrides} />;
  return render(
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <MinimizedTaskProvider>
        <CoverageErrorBoundary sourceLabel={`${modulePath}#${exportName}`}>
          {exportName === 'MinimizedTaskBar'
            ? <MinimizedTaskCoverageSeed>{component}</MinimizedTaskCoverageSeed>
            : component}
        </CoverageErrorBoundary>
      </MinimizedTaskProvider>
    </ThemeProvider>
  );
}

async function crawlProductionComponentMatrix() {
  for (const [modulePath, exports] of Object.entries(componentModules)) {
    if (inventoryModulePaths.size && !inventoryModulePaths.has(modulePath)) continue;
    for (const [exportName, Component] of Object.entries(exports || {})) {
      const renderableType = typeof Component === 'function'
        || (typeof Component === 'object' && Component !== null && Boolean(Component.$$typeof));
      if (!renderableType) continue;
      if (exportName !== 'default' && !/^[A-Z]/u.test(exportName)) continue;
      if (exportName !== 'default' && !COMPONENT_EXPORT_SUFFIX.test(exportName)) continue;
      if (componentFilter && !`${modulePath}#${exportName}`.includes(componentFilter)) continue;
      const variants = getComponentOverrideVariants(modulePath, exportName);
      for (let variant = 0; variant < variants.length; variant += 1) {
        if (componentVariantFilter && Number(componentVariantFilter) !== variant) continue;
        const replayCount = COMPONENT_REPLAY_EXPORTS.has(exportName) ? 2 : 1;
        for (let replay = 0; replay < replayCount; replay += 1) {
          reportProgress(`component ${modulePath}#${exportName} variant=${variant} replay=${replay}`);
          cleanup();
          licenseRenewalCoverage = exportName === 'DesktopAccessGate';
          try {
            renderComponent(Component, modulePath, exportName, variants[variant]);
            await settle();
            await crawlCurrentPage(`${modulePath}#${exportName}`, {
              // Later production-state variants still need to replay controls that
              // unlock their state-specific actions (for example a confirmation
              // checkbox before an upload button, or a picker before a menu item).
              allowPassedActions: replay > 0 || variant > 0,
              preferCommit: false,
              preferCloseActions: replay > 0,
              skipCloseActions: false,
              maxPasses: exportName === 'PaidPromotionPage' ? 1 : 5,
            });
          } catch (error) {
            stubCalls.push({
              method: 'COMPONENT_RENDER_SKIPPED',
              url: `${modulePath}#${exportName}`,
              error: String(error?.message || error).slice(0, 300),
            });
          } finally {
            licenseRenewalCoverage = false;
          }
        }
      }
    }
  }
  if (!componentFilter || 'useMarketingCardsState'.includes(componentFilter) || 'marketing'.includes(componentFilter)) {
    cleanup();
    renderComponent(MarketingCardsCoverageHarness, '../features/marketing/model/useMarketingCardsState.jsx', 'MarketingCardsCoverageHarness', {});
    await settle();
    await crawlCurrentPage('../features/marketing/model/useMarketingCardsState.jsx#useMarketingCardsState', { maxPasses: 5 });
  }
}

beforeAll(() => {
  const originalError = console.error.bind(console);
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const isExpectedHarnessNoise = (args) => {
    const message = args.map((item) => String(item ?? '')).join(' ');
    return message.includes('not wrapped in act(...)')
      || message.includes('MUI: You have provided an out-of-range value');
  };
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (!isExpectedHarnessNoise(args)) originalError(...args);
  });
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    if (!isExpectedHarnessNoise(args)) originalWarn(...args);
  });
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    if (!String(args[0] ?? '').startsWith('[性能]')) originalLog(...args);
  });
  localStorage.clear();
  Element.prototype.scrollIntoView ??= vi.fn();
  window.wangzaiDesktop = {
    ...(window.wangzaiDesktop || {}),
    localApiRequest: vi.fn(async ({ path: requestPath, method, body }) => ({
      ok: true,
      status: 200,
      data: await apiFixture(requestPath, { method, body }),
    })),
    cancelLocalApiRequest: vi.fn(async (requestId) => ({ ok: true, canceled: true, requestId })),
    recoveryRequest: vi.fn(async ({ command }) => {
      if (command === 'status') return { ok: true, data: { enrolled: false, reconcile: { completed: 1 } } };
      if (command === 'list-generations') return { ok: true, data: { generations: [{ generation_id: 'generation-fixture' }] } };
      if (command === 'stage-restore') return { ok: true, data: { restoreId: 'restore-fixture', shopCount: 1 } };
      if (command === 'backup-shop') return { ok: true, data: { remoteGenerationId: 'generation-fixture' } };
      if (command === 'activate-restore') return { ok: true, data: { activated: true } };
      return { ok: true, data: {} };
    }),
    reloadWindow: vi.fn(async () => ({ ok: true })),
  };
  document.addEventListener('click', (event) => {
    const pathNodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of pathNodes) {
      if (!node || typeof node !== 'object') continue;
      const reactPropsKey = Object.keys(node).find((key) => key.startsWith('__reactProps$'));
      const clickHandler = reactPropsKey ? node[reactPropsKey]?.onClick : undefined;
      if (clickHandler == null || typeof clickHandler === 'function') continue;
      const sourceId = String(node.getAttribute?.('data-v2-source-id') || event.target?.getAttribute?.('data-v2-source-id') || '');
      const label = controlLabel(node) || controlLabel(event.target);
      const message = `onClick 必须是函数，实际为 ${typeof clickHandler}；sourceId=${sourceId || 'none'}；label=${label || 'none'}`;
      stubCalls.push({ method: 'INVALID_REACT_ONCLICK', url: currentCrawlPageLabel || 'unknown-page', error: message });
      failures.push({ page: currentCrawlPageLabel || 'unknown-page', sourceId, message });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.target?.closest?.('a')) event.preventDefault();
  }, true);
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (licenseRenewalCoverage && String(url).includes('/api/license/check')) {
      return jsonResponse({ detail: 'License has expired' }, 403);
    }
    return jsonResponse(await apiFixture(url, options));
  }));
  vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('prompt', vi.fn(() => 'V2 云端测试'));
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('open', vi.fn(() => null));
  window.matchMedia ??= vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterAll(() => {
  const outputPath = String(process.env.WANGZAI_V2_UI_COVERAGE_OUTPUT || '').trim();
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify({
      contract: 'wangzai-v2-ui-runtime-coverage/v1',
      generatedAt: new Date().toISOString(),
      controls: [...passed.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en')),
      failures,
      stubCalls,
    }, null, 2)}\n`, 'utf8');
  }
  cleanup();
  consoleErrorSpy?.mockRestore();
  consoleLogSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  vi.unstubAllGlobals();
});

describe('V2 cloud UI control crawler', () => {
  it('opens every workspace and performs every reachable instrumented control against test stubs', async () => {
    if (!skipAppCrawler) {
      for (const page of pages) {
        cleanup();
        localStorage.clear();
        renderApp();
        await settle();
        if (page === '在线客服' || page === '智能回复') {
          const customerServiceNavigation = pageButton('客服咨询');
          expect(customerServiceNavigation, '缺少一级页面入口：客服咨询').toBeTruthy();
          fireEvent.click(customerServiceNavigation);
          await settle();
        }
        const navigation = pageButton(page);
        expect(navigation, `缺少页面入口：${page}`).toBeTruthy();
        fireEvent.click(navigation);
        await settle();
        await crawlCurrentPage(page, { maxPasses: 1 });
      }
    }
    await crawlProductionComponentMatrix();
    expect([...passed.values()].filter((item) => item.status === 'passed').length).toBeGreaterThan(0);
  }, 3_000_000);
});
