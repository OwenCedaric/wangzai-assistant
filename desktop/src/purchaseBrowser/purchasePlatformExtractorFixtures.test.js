import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
const numberScript = fs.readFileSync(new URL('./purchaseCaptureNumber.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
const extractorSource = numberScript + '\n' + fs.readFileSync(
  path.join(desktopRoot, 'native', 'Wangzai.CefBrowserHost', 'PurchaseProductPlatformExtractors.cs'),
  'utf8',
).match(/"""([\s\S]*?)""";/u)?.[1];

function pageContext({ url, state = {}, fetchResult = null, fetchText = '', fetchHandler = null, scripts = [], elements = {}, cookie = '', pageText = '' }) {
  const parsed = new URL(url);
  const window = { ...state };
  const querySelectorAll = (selector) => elements[selector] || [];
  const context = {
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn() {} },
    location: {
      href: parsed.href,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      origin: parsed.origin,
    },
    document: {
      scripts: scripts.map((textContent) => ({ textContent })), cookie,
      body: { innerText: pageText },
      documentElement: { outerHTML: fetchText, innerText: pageText, textContent: pageText }, querySelectorAll,
      querySelector: (selector) => querySelectorAll(selector)[0] || null,
    },
    window,
    fetch: async (requestUrl, requestOptions) => {
      const value = fetchHandler ? await fetchHandler(String(requestUrl), requestOptions) : fetchResult;
      return { ok: value !== null && value !== undefined, json: async () => value, text: async () => typeof value === 'string' ? value : fetchText };
    },
  };
  context.globalThis = context;
  return context;
}

function element({ text = '', attrs = {}, src = '' } = {}) {
  return {
    textContent: text, src,
    getAttribute(name) { return attrs[name] ?? null; },
  };
}

async function extract(platform, options) {
  const context = pageContext(options);
  vm.runInNewContext(`
    const clean = (value, max = 500) => String(value ?? '').replace(/\\s+/gu, ' ').trim().slice(0, max);
    const safeJson = (value) => { try { return JSON.parse(value); } catch { return null; } };
    ${extractorSource}
    globalThis.__extractPlatformProduct = extractPlatformProduct;
  `, context);
  return await context.__extractPlatformProduct(platform);
}

test('1688 fixture returns title, price, images, attributes and every SKU from structured state', async () => {
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/10001.html',
    scripts: [`bootstrap(window.contextPath, ${JSON.stringify({ result: {
      data: {
        Root: { fields: { dataJson: { offerId: '10001', detailContent: '<img src="https://img.example/1688-detail.jpg">完整详情', skuModel: {
          skuPriceScale: '25.5-26.5',
          skuProps: [{ value: [
            { name: '红色', imageUrl: 'https://img.example/1688-red.jpg' },
            { name: '蓝色', imageUrl: 'https://img.example/1688-blue.jpg' },
          ] }],
          skuInfoMap: {
            red: { skuId: 'sku-red', specAttrs: '红色', price: '25.5' },
            blue: { skuId: 'sku-blue', specAttrs: '蓝色', price: '26.5' },
          },
        } } } },
        gallery: { fields: { subject: '1688 遥控越野汽车', offerImgList: ['https://img.example/1688-main.jpg'] } },
      },
      global: { globalData: { model: { offerDetail: { featureAttributes: [{ name: '材质', value: '合金' }] } } } },
    } })});`],
  });
  assert.equal(result.sourceMethod, '1688-structured-state');
  assert.equal(result.productTitle, '1688 遥控越野汽车');
  assert.equal(result.purchasePrice, '25.5');
  assert.equal(result.skus.length, 2);
  assert.equal(result.mainImages.length, 1);
  assert.equal(result.detailImages.length, 1);
  assert.equal(result.attributes[0].name, '材质');
  assert.equal(result.lengthCm, '');
  assert.equal(result.widthCm, '');
  assert.equal(result.heightCm, '');
});

test('1688 fixture returns price range, freight, MOQ, category, delivery time and normalized weight', async () => {
  const root = { result: {
    data: {
      Root: { fields: { dataJson: {
        offerId: '10009', categoryId: '1033155', categoryName: '平光镜',
        skuModel: {
          skuPriceScale: '3.30-8.40',
          skuInfoMap: {
            plain: { skuId: 'sku-plain', specAttrs: '无度数', price: '3.30' },
            myopia: { skuId: 'sku-myopia', specAttrs: '近视100度', price: '8.40' },
          },
        },
      } } },
      gallery: { fields: { subject: '1688 价格与起批规则商品', offerImgList: ['https://img.example/1688-rule-main.jpg'] } },
      productPackInfo: { fields: { pieceWeightScale: { pieceWeightScaleInfo: [
        { skuId: 'sku-plain', weight: 50 }, { skuId: 'sku-myopia', unitWeight: 0.05 },
      ] } } },
    },
    global: { globalData: { model: { offerDetail: { featureAttributes: [{ name: '产品类别', value: '平光镜' }] } } } },
  } };
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/10009.html',
    scripts: [`bootstrap(window.contextPath, ${JSON.stringify(root)});`],
    pageText: '1副起批 运费¥3起 支持混批 2件以内 承诺48小时发货',
  });

  assert.equal(result.purchasePrice, '3.3');
  assert.equal(result.purchasePriceMin, '3.3');
  assert.equal(result.purchasePriceMax, '8.4');
  assert.equal(result.weightG, '50');
  assert.equal(result.weightMinG, '50');
  assert.equal(result.weightMaxG, '50');
  assert.equal(result.sourceCategoryId, '1033155');
  assert.equal(result.sourceCategoryName, '平光镜');
  assert.equal(result.shippingStatus, 'starting');
  assert.equal(result.shippingFeeMin, '3');
  assert.match(result.shippingRuleText, /按收货地区/u);
  assert.equal(result.minimumOrderQuantity, '1');
  assert.equal(result.minimumOrderUnit, '副');
  assert.equal(result.mixedBatchStatus, 'yes');
  assert.equal(result.deliveryLeadTimeHours, '48');
  assert.match(result.deliveryText, /48小时/u);
});

for (const platform of ['淘宝', '天猫']) {
  test(`${platform} fixture returns the item and SKU matrix from page state`, async () => {
    const result = await extract(platform, {
      url: platform === '天猫'
        ? 'https://detail.tmall.com/item.htm?id=20002'
        : 'https://item.taobao.com/item.htm?id=20002',
      state: {
        __INITIAL_STATE__: {
          item: { itemId: '20002', title: `${platform} 连衣裙`, images: ['https://img.example/tb-main.jpg'] },
          skuBase: {
            props: [{ values: [{ vid: '28341', name: '黑色', image: 'https://img.example/tb-black.jpg' }] }],
            skus: [{ skuId: 'tb-black', propPath: '1627207:28341' }],
          },
          skuCore: { sku2info: { 0: { price: { priceText: '88.00' } }, 'tb-black': { price: { priceText: '88.00' } } } },
          props: [{ name: '面料', value: '棉' }],
        },
      },
    });
    assert.equal(result.sourceProductId, '20002');
    assert.equal(result.productTitle, `${platform} 连衣裙`);
    assert.equal(result.purchasePrice, '88');
    assert.equal(result.currency, 'CNY');
    assert.equal(result.skus[0].name, '黑色');
    assert.equal(result.skus[0].attributes[0].name, '规格');
    assert.equal(result.skus[0].attributes[0].value, '黑色');
    assert.equal(result.mainImages.length, 1);
  });
}

test('Pinduoduo fixture keeps current yuan prices, galleries, named dimensions and SKU data', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30003',
    state: {
      store: { initDataObj: { goods: {
        goodsID: '30003', goodsName: '拼多多积木套装', minGroupPrice: '39.90',
        topGallery: [{ url: 'https://img.example/pdd-main.jpg' }],
        detailGallery: [{ url: 'https://img.example/pdd-detail.jpg' }],
        goodsProperty: [{ name: '颗粒数', value: '500' }],
        skus: [{
          skuId: 'pdd-500', groupPrice: '39.90', quantity: 88,
          specs: [{ spec_key: '颗粒数', spec_value: '500颗' }],
          thumbUrl: 'https://img.example/pdd-sku.jpg',
        }],
      } } },
    },
  });
  assert.equal(result.sourceMethod, 'pdd-runtime-state');
  assert.equal(result.purchasePrice, '39.9');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.skus[0].name, '500颗');
  assert.equal(result.skus[0].attributes[0].name, '颗粒数');
  assert.equal(result.skus[0].attributes[0].value, '500颗');
  assert.equal(result.skus[0].option.stock, 88);
  assert.equal(result.detailImages.length, 1);
});

test('Pinduoduo fixture uses explicit in-cent fields only as the cent-price fallback', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30004',
    state: {
      rawData: { store: { initDataObj: { goods: {
        goodsID: '30004', goodsName: '拼多多价格兜底商品', minOnSaleGroupPriceInCent: 2590,
        viewImageData: ['https://img.example/pdd-cent-main.jpg'],
        sku: { skus: [{
          skuID: 'pdd-cent', groupPriceInCent: 2590,
          specs: [{ spec_key: '颜色', spec_value: '蓝色' }],
        }] },
      } } } },
    },
  });
  assert.equal(result.purchasePrice, '25.9');
  assert.equal(result.skus[0].price, '25.9');
  assert.equal(result.sourceProductId, '30004');
});

test('Pinduoduo fixture reconstructs the complete SKU matrix from current React props', async () => {
  const product = {
    goodsID: '30005', goodsName: '拼多多React商品', minGroupPrice: '66',
    topGallery: [{ url: 'https://img.example/pdd-react-main.jpg' }],
    skus: [],
  };
  const skuRows = [
    { skuId: 'react-red', goodsId: '30005', groupPrice: '66', quantity: 12, specs: [{ spec_key: '颜色', spec_value: '红色' }] },
    { skuId: 'react-blue', goodsId: '30005', groupPrice: '68', quantity: 8, specs: [{ spec_key: '颜色', spec_value: '蓝色' }] },
  ];
  const reactProps = { children: { product, skuRows } };
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30005',
    elements: {
      '*': [{ __reactProps$fixture: reactProps }],
    },
  });
  assert.equal(result.sourceMethod, 'pdd-react-props');
  assert.equal(result.skus.length, 2);
  assert.equal(result.skus.map((row) => row.name).join('|'), '红色|蓝色');
  assert.equal(result.skus.map((row) => row.option.stock).join('|'), '12|8');
  assert.equal(result.purchasePriceMin, '66');
  assert.equal(result.purchasePriceMax, '68');
});

test('Pinduoduo fixture restores compact React thumbnail SKU rows', async () => {
  const product = {
    goodsID: '30006', goodsName: '拼多多缩略图SKU商品', minGroupPrice: '31',
    topGallery: [{ url: 'https://img.example/pdd-compact-main.jpg' }],
    skus: [],
  };
  const reactProps = { children: {
    compactProduct: { goodsID: '30006', goodsName: '拼多多缩略图SKU商品', skus: [] },
    product,
    options: [
      { skuId: 'compact-black', label: '经典黑', url: 'https://img.example/pdd-black.jpg' },
      { skuId: 'compact-white', label: '珍珠白', url: 'https://img.example/pdd-white.jpg' },
    ],
  } };
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30006',
    elements: { '*': [{ __reactProps$fixture: reactProps }] },
  });
  assert.equal(result.sourceMethod, 'pdd-react-props');
  assert.equal(result.skus.map((row) => row.name).join('|'), '经典黑|珍珠白');
  assert.equal(result.skus.map((row) => row.price).join('|'), '31|31');
  assert.equal(result.skus[0].imageUrl, 'https://img.example/pdd-black.jpg');
});

test('Pinduoduo fixture reads MobX observable SKU and specification arrays', async () => {
  const observableRows = (values) => {
    const result = { length: values.length };
    values.forEach((value, index) => Object.defineProperty(result, index, { value }));
    Object.defineProperty(result, 'toJSON', { value: () => values });
    return result;
  };
  const product = {
    goodsID: '300061', goodsName: '拼多多 MobX SKU 商品', minGroupPrice: '33.2',
    topGallery: observableRows([{ url: 'https://img.example/pdd-mobx-main.jpg' }]),
    skus: observableRows([
      {
        skuId: 'mobx-flight', goodsId: '300061', groupPrice: '42.7', quantity: 19,
        specs: observableRows([
          { spec_key: '系列', spec_value: '城市系列' },
          { spec_key: '尺寸', spec_value: '直升飞机运输队' },
        ]),
      },
      {
        skuId: 'mobx-chase', goodsId: '300061', groupPrice: '33.2', quantity: 92,
        specs: observableRows([
          { spec_key: '系列', spec_value: '城市系列' },
          { spec_key: '尺寸', spec_value: '高速追捕' },
        ]),
      },
    ]),
  };
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=300061',
    elements: { '*': [{ __reactProps$fixture: { product } }] },
  });

  assert.equal(result.sourceMethod, 'pdd-react-props');
  assert.equal(result.purchasePrice, '33.2');
  assert.equal(result.skus.length, 2);
  assert.equal(result.skus.map((row) => row.name).join('|'), '城市系列 / 直升飞机运输队|城市系列 / 高速追捕');
  assert.equal(result.skus[0].attributes[1].name, '尺寸');
  assert.equal(result.skus[1].option.stock, 92);
});

test('Pinduoduo fixture reads the current snake-case API projection', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30007',
    state: { rawData: { store: { initDataObj: { goods: {
      goods_id: '30007', goods_name: '拼多多新接口商品', min_group_price: 4590,
      top_gallery: [{ url: 'https://img.example/pdd-api-main.jpg' }],
      sku: [{
        sku_id: 'api-green', group_price: 4590, quantity: 21,
        specs: [{ spec_key: '颜色', spec_value: '绿色' }],
      }],
    } } } } },
  });
  assert.equal(result.productTitle, '拼多多新接口商品');
  assert.equal(result.purchasePrice, '45.9');
  assert.equal(result.skus[0].price, '45.9');
  assert.equal(result.skus[0].name, '绿色');
});

test('Pinduoduo fixture uses the visible coupon price when the SKU rows omit price fields', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30008',
    pageText: '百亿补贴 券后¥72 已选：蓝色',
    state: { rawData: { store: { initDataObj: { goods: {
      goodsID: '30008', goodsName: '拼多多可见价格商品',
      topGallery: [{ url: 'https://img.example/pdd-visible-price.jpg' }],
      skus: [{ skuId: 'visible-blue', specs: [{ spec_key: '颜色', spec_value: '蓝色' }] }],
    } } } } },
  });
  assert.equal(result.purchasePrice, '72');
  assert.equal(result.skus[0].price, '72');
  assert.equal(result.skus[0].name, '蓝色');
});

test('Pinduoduo fixture reads a split first-item limited price before the regular SKU price', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=300081',
    pageText: '限量价 首件 ￥ 22 . 3 即将恢复原价',
    state: { rawData: { store: { initDataObj: { goods: {
      goodsID: '300081', goodsName: '拼多多首件限量商品', minGroupPrice: '62.3',
      topGallery: [{ url: 'https://img.example/pdd-first-item.jpg' }],
      skus: [{
        skuId: 'first-item-box', groupPrice: '62.3',
        specs: [{ spec_key: '包装', spec_value: '一盒' }],
      }],
    } } } } },
  });
  assert.equal(result.purchasePrice, '22.3');
  assert.equal(result.skus[0].price, '62.3');
});

test('Pinduoduo fixture rejects a small promotion amount as the SKU price', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30009',
    pageText: '立减5元 券后¥572',
    state: { rawData: { store: { initDataObj: { goods: {
      goodsID: '30009', goodsName: '拼多多促销金额商品',
      topGallery: [{ url: 'https://img.example/pdd-promo.jpg' }],
      skus: [{ skuId: 'promo-default', priceDisplay: { price: '5' } }],
    } } } } },
  });
  assert.equal(result.purchasePrice, '572');
  assert.equal(result.skus[0].price, '572');
  assert.equal(result.skus[0].name, '默认规格');
});

test('Pinduoduo fixture rejects a goods-level discount amount as a price outlier', async () => {
  const result = await extract('拼多多', {
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=30010',
    state: { rawData: { store: { initDataObj: { goods: {
      goodsID: '30010', goodsName: '拼多多商品级价格离群值',
      minGroupPrice: 5, minOnSaleGroupPriceInCent: 57200, maxNormalPrice: 621,
      topGallery: [{ url: 'https://img.example/pdd-goods-price.jpg' }],
      skus: [{ skuId: 'goods-price-default', priceDisplay: { price: '5' } }],
    } } } } },
  });
  assert.equal(result.purchasePrice, '572');
  assert.equal(result.skus[0].price, '572');
});

test('Ozon fixture reads composer widget state instead of unrelated DOM cards', async () => {
  const result = await extract('Ozon买家', {
    url: 'https://www.ozon.ru/product/test-40004/',
    fetchResult: {
      widgetStates: {
        webProductHeading: JSON.stringify({ title: 'Ozon 遥控汽车', sku: '40004' }),
        webPrice: JSON.stringify({ price: '1 999 ₽' }),
        webGallery: JSON.stringify({ items: [{ image: 'https://img.example/ozon-main.jpg' }] }),
        webDescription: JSON.stringify({ content: '<img src="https://img.example/ozon-detail.jpg">Описание' }),
        webCharacteristics: JSON.stringify({ characteristics: [{ name: 'Материал', value: 'Металл' }] }),
        webAspects: JSON.stringify({ variants: [{ sku: '40004', title: 'Красный', price: '1 999 ₽' }] }),
      },
    },
  });
  assert.equal(result.sourceMethod, 'ozon-widget-state');
  assert.equal(result.productTitle, 'Ozon 遥控汽车');
  assert.equal(result.purchasePrice, '1999');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.skus[0].id, '40004');
  assert.equal(result.attributes[0].name, 'Материал');
});

test('1688 default version fixture keeps per-SKU price, image and package weight', async () => {
  const root = { result: {
    data: {
      Root: { fields: { dataJson: { offerId: '41001', skuModel: {
        skuPriceScale: '5.40-8.40',
        skuProps: [{ value: [{ name: '银框', imageUrl: 'https://img.example/1688-silver.jpg' }] }],
        skuInfoMap: { silver: { skuId: 'silver-1', specAttrs: '银框 > 近视100度', price: '8.40' } },
      } } } },
      gallery: { fields: { subject: '感光变色眼镜', offerImgList: ['https://img.example/1688-glasses.jpg'] } },
      productPackInfo: { fields: {
        packageDimensions: '22 × 9 × 7 cm',
        pieceWeightScale: { pieceWeightScaleInfo: [{
          skuId: 'silver-1', unitWeight: 0.18,
          packageLengthMm: 230, packageWidthMm: 100, packageHeightMm: 80,
        }] },
      } },
    },
    global: { globalData: { model: { offerDetail: { featureAttributes: [{ name: '镜架', value: '金属' }] } } } },
  } };
  const html = `<script>bootstrap(window.contextPath, ${JSON.stringify(root)});</script>`;
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/41001.html',
    fetchHandler: async () => html,
  });
  assert.equal(result.sourceMethod, '1688-default-structured');
  assert.equal(result.productTitle, '感光变色眼镜');
  assert.equal(result.skus[0].price, '8.4');
  assert.equal(result.skus[0].weightG, '180');
  assert.equal(result.skus[0].imageUrl, 'https://img.example/1688-silver.jpg');
  assert.deepEqual(
    { lengthCm: result.lengthCm, widthCm: result.widthCm, heightCm: result.heightCm },
    { lengthCm: '22', widthCm: '9', heightCm: '7' },
  );
  assert.deepEqual(
    { lengthCm: result.skus[0].lengthCm, widthCm: result.skus[0].widthCm, heightCm: result.skus[0].heightCm },
    { lengthCm: '23', widthCm: '10', heightCm: '8' },
  );
});

test('1688 fixture reads seller-provided package dimensions from product attributes and inherits them to SKUs', async () => {
  const root = { result: {
    data: {
      Root: { fields: { dataJson: { offerId: '41004', skuModel: {
        skuPriceScale: '12.00',
        skuInfoMap: { default: { skuId: 'sku-default', specAttrs: '默认款', price: '12.00' } },
      } } } },
      gallery: { fields: { subject: '属性包装尺寸商品', offerImgList: ['https://img.example/1688-package.jpg'] } },
    },
    global: { globalData: { model: { offerDetail: { featureAttributes: [
      { name: '材质', value: '金属' },
      { name: '包装尺寸', value: '31.5*12*6.5厘米' },
    ] } } } },
  } };
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/41004.html',
    fetchHandler: async () => `<script>bootstrap(window.contextPath, ${JSON.stringify(root)});</script>`,
  });

  assert.deepEqual(
    { lengthCm: result.lengthCm, widthCm: result.widthCm, heightCm: result.heightCm },
    { lengthCm: '31.5', widthCm: '12', heightCm: '6.5' },
  );
  assert.deepEqual(
    { lengthCm: result.skus[0].lengthCm, widthCm: result.skus[0].widthCm, heightCm: result.skus[0].heightCm },
    { lengthCm: '31.5', widthCm: '12', heightCm: '6.5' },
  );
});

test('1688 default version repairs bare numeric skuInfoMap keys and keeps the full matrix', async () => {
  const root = { result: {
    data: {
      Root: { fields: { dataJson: { offerId: '41002', skuModel: {
        skuPriceScale: '5.40-8.40',
        skuProps: [{ value: [
          { name: '金框', imageUrl: 'https://img.example/1688-gold.jpg' },
          { name: '银框', imageUrl: 'https://img.example/1688-silver.jpg' },
        ] }],
        skuInfoMap: {
          5934148230620: { skuId: 'gold-plain', specAttrs: '金框 > 无度数平光镜', price: '5.40' },
          5934148230621: { skuId: 'silver-100', specAttrs: '银框 > 近视100度', price: '8.40' },
        },
      } } } },
      gallery: { fields: { subject: '全量 SKU 眼镜', offerImgList: [
        'https://img.example/1688-main-1.jpg', 'https://img.example/1688-main-2.jpg',
      ] } },
      productPackInfo: { fields: { pieceWeightScale: { pieceWeightScaleInfo: [
        { skuId: 'gold-plain', weight: 50 }, { skuId: 'silver-100', weight: 50 },
      ] } } },
    },
  } };
  const jsonWithBareNumericKeys = JSON.stringify(root)
    .replace('"5934148230620":', '5934148230620:')
    .replace('"5934148230621":', '5934148230621:');
  const html = `<script>bootstrap(window.contextPath, ${jsonWithBareNumericKeys});</script>`;
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/41002.html',
    fetchHandler: async () => html,
  });

  assert.equal(result.sourceMethod, '1688-default-structured');
  assert.equal(result.skus.length, 2);
  assert.deepEqual(Array.from(result.skus, (sku) => sku.id), ['gold-plain', 'silver-100']);
  assert.equal(result.mainImages.length, 2);
  assert.equal(result.skuImages.length, 2);
  assert.equal(result.skus[0].weightG, '50');
});

test('1688 structured extraction does not truncate a large SKU matrix at the old 200-row limit', async () => {
  const skuInfoMap = Object.fromEntries(Array.from({ length: 260 }, (_, index) => [
    String(6000000000000 + index),
    { skuId: `sku-${index + 1}`, specAttrs: `颜色${index + 1}`, price: '9.90' },
  ]));
  const root = { result: { data: {
    Root: { fields: { dataJson: { offerId: '41003', skuModel: { skuPriceScale: '9.90', skuInfoMap } } } },
    gallery: { fields: { subject: '大规格矩阵商品', offerImgList: ['https://img.example/1688-large-main.jpg'] } },
  } } };
  const result = await extract('1688', {
    url: 'https://detail.1688.com/offer/41003.html',
    fetchHandler: async () => `<script>bootstrap(window.contextPath, ${JSON.stringify(root)});</script>`,
  });
  assert.equal(result.skus.length, 260);
  assert.equal(result.skus.at(-1).id, 'sku-260');
});

test('JD fixture reads imageList/colorSize and variant price from product HTML', async () => {
  const html = `<html><head><title>京东机械键盘</title></head><body>
    <script charset="gbk">var pageConfig={imageList:["jfs/main.jpg"],colorSize:[{"skuId":"50005","color":"红轴"}]};</script>
    <div class="summary-price-wrap"><span class="price">299.00</span></div></body></html>`;
  const result = await extract('京东', {
    url: 'https://item.jd.com/50005.html', fetchHandler: async () => html,
  });
  assert.equal(result.sourceMethod, 'jd-color-size-pages');
  assert.equal(result.sourceProductId, '50005');
  assert.equal(result.purchasePrice, '299');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.skus[0].name, '红轴');
  assert.equal(result.skus[0].attributes[0].name, '颜色');
  assert.equal(result.skus[0].attributes[0].value, '红轴');
  assert.match(result.mainImages[0], /360buyimg\.com\/sku\/jfs\/main\.jpg/u);
});

test('Temu fixture reads rawData goods, properties, gallery and SKU matrix', async () => {
  const result = await extract('Temu', {
    url: 'https://www.temu.com/tool-set-g-60006.html?goods_id=60006',
    state: { rawData: { store: {
      goods: { goodsId: '60006', goodsName: 'Temu 工具套装', gallery: [{ url: 'https://img.example/temu-main.jpg' }],
        goodsProperty: [{ key: '材质', values: ['合金'] }], video: { videoUrl: 'https://video.example/temu.mp4' } },
      sku: [{ skuId: 'temu-red', normalPriceStr: '$12.99', thumbUrl: 'https://img.example/temu-red.jpg', specs: [{ name: '红色' }] }],
    } } },
  });
  assert.equal(result.sourceMethod, 'temu-raw-data');
  assert.equal(result.productTitle, 'Temu 工具套装');
  assert.equal(result.purchasePrice, '12.99');
  assert.equal(result.currency, 'USD');
  assert.equal(result.skus[0].attributes[0].name, '规格');
  assert.equal(result.skus[0].attributes[0].value, '红色');
  assert.equal(result.attributes[0].value, '合金');
});

test('AliExpress fixture reads the same-origin productData fallback', async () => {
  const result = await extract('AliExpress', {
    url: 'https://www.aliexpress.com/item/70007.html',
    fetchResult: { data: {
      productId: '70007', name: 'AliExpress 露营灯', gallery: [{ imageUrl: 'https://img.example/ali-main.jpg' }],
      description: '<img src="https://img.example/ali-detail.jpg">露营灯详情',
      skuInfo: {
        propertyList: [{ values: [{ id: '11', name: '暖白', imageMainUrl: 'https://img.example/ali-warm.jpg' }] }],
        priceList: [{ skuId: 'ali-warm', skuPropIds: ['11'], activityAmount: { formatted: 'US $15.80' } }],
      },
    } },
  });
  assert.equal(result.sourceMethod, 'aliexpress-json-api');
  assert.equal(result.productTitle, 'AliExpress 露营灯');
  assert.equal(result.skus[0].name, '暖白');
  assert.equal(result.currency, 'USD');
  assert.equal(result.skus[0].attributes[0].name, '规格');
  assert.equal(result.skus[0].attributes[0].value, '暖白');
  assert.equal(result.detailImages.length, 1);
});

test('Amazon fixture reads ASIN, dynamic gallery, dimensions and variants', async () => {
  const result = await extract('Amazon', {
    url: 'https://www.amazon.com/dp/B0ABC12345',
    state: { __INITIAL_STATE__: { dimensionToAsinMap: { Red: 'B0ABC12345' }, dimensionValuesDisplayData: { B0ABC12345: ['Red'] } } },
    elements: {
      '#landingImage': [element({ attrs: { 'data-a-dynamic-image': JSON.stringify({ 'https://img.example/amz-main.jpg': [1200, 1200] }) } })],
      '#productTitle': [element({ text: 'Amazon 咖啡机' })],
      '.a-price .a-offscreen': [element({ text: '$89.99' })],
      '#feature-bullets .a-list-item, #productDescription, .a-expander-content .a-list-item': [element({ text: '一键萃取' })],
    },
  });
  assert.equal(result.sourceMethod, 'amazon-page-structure');
  assert.equal(result.sourceProductId, 'B0ABC12345');
  assert.equal(result.purchasePrice, '89.99');
  assert.equal(result.currency, 'USD');
  assert.equal(result.skus[0].attributes[0].name, '规格');
  assert.equal(result.skus[0].attributes[0].value, 'Red');
  assert.equal(result.mainImages[0], 'https://img.example/amz-main.jpg');
});

for (const [price, amount] of [['$1,299.90', '1299.9'], ['1.299,90 €', '1299.9'], ['1 299,90 ₽', '1299.9'], ['$3.299', '3.299']]) {
  test(`product price, range and SKU share the same numeric parsing for ${price}`, async () => {
    const result = await extract('Amazon', {
      url: 'https://www.amazon.com/dp/B0ABC12345',
      state: { __INITIAL_STATE__: { dimensionToAsinMap: { Red: 'B0ABC12345' }, dimensionValuesDisplayData: { B0ABC12345: ['Red'] } } },
      elements: {
        '#landingImage': [element({ attrs: { 'data-a-dynamic-image': JSON.stringify({ 'https://img.example/amz-main.jpg': [1200, 1200] }) } })],
        '#productTitle': [element({ text: '隔离价格读取商品' })],
        '.a-price .a-offscreen': [element({ text: price })],
      },
    });
    assert.equal(result.purchasePrice, amount);
    assert.equal(result.purchasePriceMin, amount);
    assert.equal(result.purchasePriceMax, amount);
    assert.equal(result.skus[0].price, amount);
  });
}

test('Wildberries fixture reads card API sizes and constructs full product gallery', async () => {
  const result = await extract('Wildberries', {
    url: 'https://www.wildberries.ru/catalog/80008/detail.aspx',
    fetchResult: { data: { products: [{ id: 80008, name: 'WB 背包', brand: 'Test', pics: 2,
      description: '旅行背包', colors: [{ name: '黑色' }], sizes: [{ chrtId: 'wb-one', origName: '0', price: { product: 459900 } }],
      options: [{ name: '容量', value: '30 л' }] }] } },
  });
  assert.equal(result.sourceMethod, 'wildberries-card-api');
  assert.equal(result.purchasePrice, '4599');
  assert.equal(result.currency, 'RUB');
  assert.equal(result.skus[0].name, '黑色');
  assert.equal(result.skus[0].attributes[0].name, '颜色');
  assert.equal(result.skus[0].attributes[0].value, '黑色');
  assert.equal(result.mainImages.length, 2);
});
