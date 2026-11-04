import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const captureSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'PurchaseCaptureScript.cs'),
  'utf8',
);
const extractorSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'PurchaseProductPlatformExtractors.cs'),
  'utf8',
);
const pinduoduoOrderSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'PinduoduoOrderCaptureScript.cs'),
  'utf8',
);
const alibaba1688OrderSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'Alibaba1688OrderCaptureScript.cs'),
  'utf8',
);
const sessionSource = fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'BrowserSession.cs'),
  'utf8',
);

test('1688 商品读取优先使用结构化标题和页面标题，不把供应商 H1 当商品名', () => {
  const titleBlock = captureSource.match(
    /const structuredProductTitle[\s\S]*?const selectedVariants/u,
  )?.[0] || '';

  assert.match(captureSource, /document\.title\.replace\(\/\\s\*\[-_\|\]\\s\*\(\?:阿里巴巴\|1688\)/u);
  assert.match(titleBlock, /structuredProductTitle[\s\S]*?documentProductTitle[\s\S]*?first\(\[\.\.\.\(selectors\.title/u);
  assert.doesNotMatch(titleBlock, /first\(\[[\s\S]*?h1[\s\S]*?\)\s*\|\|\s*structuredProductTitle/u);
});

test('十个平台优先读取结构化商品数据并通过 Promise 等待页面接口', () => {
  assert.match(extractorSource, /1688-structured-state/u);
  assert.match(extractorSource, /1688-default-structured/u);
  assert.match(extractorSource, /mtop\.taobao\.pcdetail\.data\.get/u);
  assert.match(extractorSource, /mtop\.taobao\.detail\.getdesc/u);
  assert.match(extractorSource, /pdd-runtime-state/u);
  assert.match(extractorSource, /jd-color-size-pages/u);
  assert.match(extractorSource, /wildberries-card-api/u);
  assert.match(extractorSource, /amazon-page-structure/u);
  assert.match(extractorSource, /temu-raw-data/u);
  assert.match(extractorSource, /aliexpress-mtop/u);
  assert.match(extractorSource, /aliexpress-json-api/u);
  assert.match(extractorSource, /composer-api\.bx\/page\/json\/v2/u);
  assert.match(extractorSource, /entrypoint-api\.bx\/page\/json\/v2/u);
  assert.match(captureSource, /captureStatus, rejectionReasons/u);
  assert.match(sessionSource, /EvaluateScriptAsPromiseAsync/u);
});

test('拼多多付款回传固定读取订单号、实付款和付款状态', () => {
  assert.match(pinduoduoOrderSource, /order_sn/u);
  assert.match(pinduoduoOrderSource, /orderSn/u);
  assert.match(pinduoduoOrderSource, /实付款/u);
  assert.match(pinduoduoOrderSource, /paymentConfirmed/u);
  assert.match(pinduoduoOrderSource, /待发货/u);
  assert.match(sessionSource, /case "inspect-pinduoduo-order"/u);
  assert.match(sessionSource, /PinduoduoOrderCaptureScript\.Value/u);
  assert.match(captureSource, /order_sn/u);
  assert.match(captureSource, /purchaseOrderStatus/u);
});

test('拼多多商品链接优先于页面里的我的订单导航文字', () => {
  const pageTypeBlock = captureSource.match(/const pageHaystack[\s\S]*?const titleNoise/u)?.[0] || '';
  assert.match(pageTypeBlock, /location\.pathname\} \$\{location\.search/u);
  assert.match(pageTypeBlock, /const explicitProductRoute/u);
  assert.match(pageTypeBlock, /sourceProductId && hasStructuredProduct && explicitProductRoute \? 'product'/u);
  assert.match(pageTypeBlock, /: \/我的订单\|订单列表/u);
});

test('1688付款回传按订单卡片读取订单号、总金额和状态', () => {
  assert.match(alibaba1688OrderSource, /订单号\|订单编号\|交易号\|交易编号/u);
  assert.match(alibaba1688OrderSource, /订单实付\|实付款[\s\S]*?实付金额\|付款金额\|支付金额\|订单金额\|应付金额[\s\S]*?总金额\|总计\|合计/u);
  assert.match(alibaba1688OrderSource, /orderCandidates/u);
  assert.match(alibaba1688OrderSource, /paymentConfirmed/u);
  assert.match(sessionSource, /case "inspect-1688-order"/u);
  assert.match(sessionSource, /Alibaba1688OrderCaptureScript\.Value/u);
});
