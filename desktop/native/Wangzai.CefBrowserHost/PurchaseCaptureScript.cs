namespace Wangzai.CefBrowserHost;

internal static class PurchaseCaptureScript
{
	public static readonly string Value = """
(async () => {
  const clean = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, max);
  const textOf = (element) => clean(element?.value ?? element?.getAttribute?.('content') ?? element?.getAttribute?.('data-value') ?? element?.textContent);
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 0 && rect.height >= 0;
  };
  const first = (selectors, max = 500) => {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const value = clean(textOf(element), max);
        if (value && visible(element)) return value;
      }
    }
    return '';
  };
  const unique = (values, max = 6) => [...new Set(values.map(value => clean(value, 180)).filter(Boolean))].slice(0, max);
  const body = clean(String(document.body?.innerText || '').replace(/[\r\n\t]/gu, ' '), 40000);
  const labeled = (expressions, max = 260) => {
    for (const expression of expressions) {
      const match = body.match(expression);
      if (match?.[1]) return clean(match[1], max);
    }
    return '';
  };
  const safeJson = (value) => { try { return JSON.parse(value); } catch { return null; } };
  const flatten = (value) => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value] : [];
  const structured = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap(script => flatten(safeJson(script.textContent || '')))
    .slice(0, 100);
  const productJson = structured.find(value => {
    const type = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
    return type.some(entry => String(entry || '').toLowerCase() === 'product');
  }) || {};
  const offerRows = Array.isArray(productJson.offers) ? productJson.offers : productJson.offers ? [productJson.offers] : [];
  const offerJson = offerRows[0] || {};
  const host = location.hostname.toLowerCase();
  const platform = host.includes('1688.com') || host.includes('alibaba.com') ? '1688'
    : host.includes('yangkeduo.com') || host.includes('pinduoduo.com') ? '拼多多'
      : host.includes('tmall.com') ? '天猫'
        : host.includes('taobao.com') ? '淘宝'
          : (host === 'ozon.ru' || host.endsWith('.ozon.ru')) && host !== 'seller.ozon.ru' ? 'Ozon买家'
            : host.includes('jd.com') ? '京东'
              : host.includes('wildberries.ru') ? 'Wildberries'
                : host.includes('amazon.') ? 'Amazon'
                  : host.includes('temu.com') ? 'Temu'
                    : host.includes('aliexpress.') ? 'AliExpress' : 'unknown';
""" + PurchaseProductPlatformExtractors.Value + """
  const platformProduct = await extractPlatformProduct(platform);
  const hasStructuredProduct = Boolean(platformProduct.sourceMethod)
    && !/(?:dom-fallback|structured-missing)$/u.test(platformProduct.sourceMethod);
  const selectors = {
    '1688': {
      title: ['[class*="title-text"]', '[class*="offer-title"]', '[data-testid*="title"]', 'h1'],
      price: ['[class*="price"] [class*="value"]', '[class*="price-text"]', '[data-price]'],
      quantity: ['input[name*="quantity"]', 'input[class*="amount"]', '[data-quantity]'],
      order: ['[data-order-id]', '[data-trade-id]', '[class*="order-number"]'],
    },
    '淘宝': {
      title: ['a[href*="item.taobao.com/item.htm"]', '[class*="ItemTitle"]', '[class*="item-title"]', '[data-testid*="title"]', 'h1'],
      price: ['[class*="Price"]', '[class*="price"]', '[data-price]'],
      quantity: ['input[name*="quantity"]', 'input[class*="quantity"]', '[data-quantity]'],
      order: ['[data-order-id]', '[data-trade-id]', '[class*="order-number"]'],
    },
    '天猫': {
      title: ['a[href*="detail.tmall.com/item.htm"]', '[class*="ItemTitle"]', '[class*="item-title"]', '[data-testid*="title"]', 'h1'],
      price: ['[class*="Price"]', '[class*="price"]', '[data-price]'],
      quantity: ['input[name*="quantity"]', 'input[class*="quantity"]', '[data-quantity]'],
      order: ['[data-order-id]', '[data-trade-id]', '[class*="order-number"]'],
    },
    '拼多多': {
      title: ['a[href*="goods.html"]', 'a[href*="goods_id="]', '[class*="goods-name"]', '[class*="goodsName"]', '[data-testid*="title"]', 'h1'],
      price: ['[class*="goods-price"]', '[class*="price"]', '[data-price]'],
      quantity: ['input[name*="quantity"]', 'input[class*="quantity"]', '[data-quantity]'],
      order: ['[data-order-id]', '[class*="order-number"]'],
    },
    'Ozon买家': {
      title: ['[data-widget="webProductHeading"] h1', 'h1', '[data-widget*="productTitle"]', '[data-testid*="title"]'],
      price: ['[data-widget="webPrice"]', '[data-widget*="price"]', '[class*="price"]', '[data-price]'],
      quantity: ['input[name*="quantity"]', 'input[class*="quantity"]', '[data-quantity]'],
      order: ['[data-order-id]', '[data-widget*="order"] [class*="number"]', '[class*="order-number"]'],
    },
    unknown: { title: ['h1'], price: ['[data-price]'], quantity: ['[data-quantity]'], order: ['[data-order-id]'] },
  }[platform] || {};
  const meta = (selector) => clean(document.querySelector(selector)?.getAttribute('content'));
  // A current 1688 product page can render the supplier name as the first H1.
  // Its document title still carries the real offer title, so prefer structured
  // product metadata and the cleaned document title before any generic H1.
  const structuredProductTitle = clean(productJson.name || meta('meta[property="og:title"]'), 600);
  const documentProductTitle = platform === '1688'
    ? clean(document.title.replace(/\s*[-_|]\s*(?:阿里巴巴|1688).*$/iu, ''), 600)
    : '';
  const productTitle = clean(
    first(['[data-wangzai-field="productTitle"]'], 600)
      || platformProduct.productTitle
      || structuredProductTitle
      || documentProductTitle
      || first([...(selectors.title || [])], 600),
    600,
  );
  const selectedVariants = unique([
    ...document.querySelectorAll('[data-selected-variant], [data-selected-sku], [aria-checked="true"], [class*="sku"] [class*="selected"], [class*="Sku"] [class*="selected"]'),
  ].filter(visible).map(textOf).filter(value => value.length <= 180));
  const variant = first(['[data-wangzai-field="variant"]', '[data-selected-variant]', '[data-selected-sku]'], 260)
    || selectedVariants.join(' / ');
  const quantity = first(['[data-wangzai-field="quantity"]', ...(selectors.quantity || []), '[data-order-quantity]'], 40)
    || labeled([/(?:购买数量|商品数量|数量)\s*[:：x×]?\s*(\d{1,6})/u], 40);
  const orderParams = new URLSearchParams(location.search || '');
  const urlOrder = ['orderId', 'order_id', 'orderSn', 'order_sn', 'tradeId', 'trade_id', 'bizOrderId', 'biz_order_id']
    .map(key => clean(orderParams.get(key), 260)).find(Boolean) || '';
  const taobaoOrderPage = ['淘宝', '天猫'].includes(platform)
    && Boolean(urlOrder || /\/(?:trade|order)\/detail(?:[/.]|$)|order[_/-]?detail/u.test(location.pathname)
      || /订单详情|交易详情/u.test(document.title));
  const explicitOrderAmount = first([
    '[data-wangzai-field="amount"]', '[data-order-amount]', 'meta[name="purchase-amount"]',
    '[data-pay-amount]', '[data-paid-amount]', '[data-total-amount]', '[data-total-fee]',
  ], 120) || labeled([
    /(?:订单实付|实付款(?:含运费)?|实付金额|付款金额|支付金额|订单金额|应付金额|应付总额|订单总价|总金额|总计|合计)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d{1,2})?)/u,
  ], 120);
  // An item unit price (or a recommendation price) is not the paid order total.
  // Keep product-page extraction unchanged; order details require total evidence.
  const rawAmount = explicitOrderAmount || (taobaoOrderPage ? '' : clean(platformProduct.purchasePrice, 120) || first([
    'meta[property="product:price:amount"]', '[itemprop="price"]', ...(selectors.price || []),
  ], 120) || clean(offerJson.price, 120) || labeled([
    /(?:价格|单价)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d{1,2})?)/u,
    /(?:Итого|Стоимость|Цена)\s*[:：]?\s*([\d\s,]+(?:\.\d{1,2})?)/iu,
  ], 120));
  const capturedAmount = parseCaptureNumber(rawAmount);
  const amount = capturedAmount === null ? '' : String(capturedAmount);
  const numeric = (value) => {
    const match = clean(typeof value === 'object' ? value?.value ?? value?.['@value'] : value, 80)
      .replace(',', '.')
      .match(/\d+(?:\.\d+)?/u);
    const number = match ? Number(match[0]) : Number.NaN;
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const unitText = (value) => clean(typeof value === 'object' ? value?.unitCode ?? value?.unitText : '', 30).toLowerCase();
  const toCentimeters = (value, fallbackUnit = '') => {
    const number = numeric(value);
    if (number === null) return null;
    const unit = `${unitText(value)} ${clean(fallbackUnit, 30).toLowerCase()}`;
    if (/\b(?:m|mtr|meter|метр)\b|米/u.test(unit) && !/(?:cm|mm|厘米|毫米)/u.test(unit)) return number * 100;
    if (/(?:mm|毫米|миллимет)/u.test(unit)) return number / 10;
    return number;
  };
  const toKilograms = (value, fallbackUnit = '') => {
    const number = numeric(value);
    if (number === null) return null;
    const unit = `${unitText(value)} ${clean(fallbackUnit, 30).toLowerCase()}`;
    if (/(?:mg|毫克)/u.test(unit)) return number / 1000000;
    if (/(?:^|\s)(?:g|гр|gram)|克|грамм/u.test(unit) && !/(?:kg|кг|千克|килограмм)/u.test(unit)) return number / 1000;
    return number;
  };
  const additionalProperties = Array.isArray(productJson.additionalProperty)
    ? productJson.additionalProperty
    : productJson.additionalProperty ? [productJson.additionalProperty] : [];
  const propertyValue = (pattern) => {
    const row = additionalProperties.find(item => pattern.test(clean(item?.name || item?.propertyID, 100)));
    return row?.value ?? row?.valueReference ?? null;
  };
  const dimensionText = first([
    '[data-wangzai-field="packageDimensions"]', '[data-package-dimensions]', '[itemprop="width"]',
    '[class*="dimension"]', '[class*="Dimension"]', '[class*="size-info"]',
  ], 180) || labeled([
    /(?:包装尺寸|包裹尺寸|商品尺寸|长[×x*]宽[×x*]高)\s*[:：]?\s*([^\n]{3,100})/u,
    /(?:Размеры упаковки|Габариты|Размер товара)\s*[:：]?\s*([^\n]{3,100})/iu,
  ], 180);
  const dimensionValues = (dimensionText.match(/\d+(?:[.,]\d+)?/gu) || [])
    .slice(0, 3)
    .map(value => Number(value.replace(',', '.')))
    .filter(value => Number.isFinite(value) && value > 0);
  const dimensionUnit = /(?:mm|毫米|миллимет)/iu.test(dimensionText) ? 'mm'
    : /(?:\bm\b|米|метр)/iu.test(dimensionText) && !/(?:cm|mm|厘米|毫米)/iu.test(dimensionText) ? 'm' : 'cm';
  const lengthCm = numeric(platformProduct.lengthCm) ?? toCentimeters(productJson.depth ?? productJson.length ?? propertyValue(/(?:длина|length|长)/iu), unitText(productJson.depth ?? productJson.length) || dimensionUnit)
    ?? toCentimeters(dimensionValues[0], dimensionUnit);
  const widthCm = numeric(platformProduct.widthCm) ?? toCentimeters(productJson.width ?? propertyValue(/(?:ширина|width|宽)/iu), unitText(productJson.width) || dimensionUnit)
    ?? toCentimeters(dimensionValues[1], dimensionUnit);
  const heightCm = numeric(platformProduct.heightCm) ?? toCentimeters(productJson.height ?? propertyValue(/(?:высота|height|高)/iu), unitText(productJson.height) || dimensionUnit)
    ?? toCentimeters(dimensionValues[2], dimensionUnit);
  const rawWeight = productJson.weight ?? propertyValue(/(?:вес|weight|重量)/iu)
    ?? first(['[data-wangzai-field="packageWeight"]', '[data-package-weight]', '[itemprop="weight"]', '[class*="weight"]'], 100)
    ?? labeled([
      /(?:包装重量|包裹重量|商品重量|重量)\s*[:：]?\s*([\d.,]+\s*(?:kg|g|千克|克)?)/u,
      /(?:Вес упаковки|Вес товара|Вес)\s*[:：]?\s*([\d.,]+\s*(?:кг|г)?)/iu,
    ], 100);
  const weightKg = numeric(platformProduct.weightKg)
    ?? (numeric(platformProduct.weightG) !== null ? numeric(platformProduct.weightG) / 1000 : null)
    ?? toKilograms(rawWeight, typeof rawWeight === 'string' ? rawWeight : unitText(rawWeight));
  const imageValues = Array.isArray(productJson.image) ? productJson.image : productJson.image ? [productJson.image] : [];
  const safeImageUrl = (value) => {
    try {
      const text = clean(typeof value === 'object' ? value?.url || value?.contentUrl : value, 1800);
      if (!text) return '';
      const url = new URL(text, location.href);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
    } catch { return ''; }
  };
  const imageSource = (element) => {
    if (!element) return '';
    const sourceSet = clean(element.getAttribute?.('srcset'), 6000)
      .split(/\s*,\s*/u)
      .map(entry => entry.trim().split(/\s+/u)[0])
      .filter(Boolean)
      .reverse();
    const candidates = [
      element.getAttribute?.('data-ks-lazyload'), element.getAttribute?.('data-lazy-src'),
      element.getAttribute?.('data-original'), element.getAttribute?.('data-src'),
      ...sourceSet, element.currentSrc, element.src, element.getAttribute?.('src'),
    ];
    return candidates.map(safeImageUrl).find(Boolean) || '';
  };
  const imageNoisePattern = /(?:^|[\W_])(?:logo|favicon|icon|iconfont|sprite|avatar|badge|qrcode|qr-code|toolbar|service|payment|pay-logo|shipping|delivery|guarantee|coupon|chat|loading|spinner|placeholder|transparent|blank|pixel|tracker|analytics)(?:[\W_]|$)/iu;
  const blockedImageRegionPattern = /(?:recommend|related|advert|promotion|sidebar|toolbar|header|footer|seller|shop-info|store-info|service|comment|review)/iu;
  const elementEvidence = (element, depth = 4) => {
    const values = [];
    let current = element;
    for (let index = 0; current && index < depth; index += 1, current = current.parentElement) {
      values.push(current.id, current.className, current.getAttribute?.('data-widget'), current.getAttribute?.('data-module'));
    }
    return clean(values.filter(value => typeof value === 'string').join(' '), 3000).toLowerCase();
  };
  const usableImage = (url, element, kind) => {
    if (!url) return false;
    let evidence = url;
    try {
      const parsed = new URL(url);
      evidence = `${parsed.hostname}${decodeURIComponent(parsed.pathname)}`;
      if (/\.(?:svg|ico)$/iu.test(parsed.pathname)) return false;
    } catch { return false; }
    if (imageNoisePattern.test(evidence.toLowerCase())) return false;
    if (element?.closest?.('header, nav, footer, aside, [role="banner"], [role="navigation"]')) return false;
    if (element && blockedImageRegionPattern.test(elementEvidence(element)) && kind !== 'sku') return false;
    const width = Number(element?.naturalWidth || element?.getBoundingClientRect?.().width || 0);
    const height = Number(element?.naturalHeight || element?.getBoundingClientRect?.().height || 0);
    if (width > 0 && height > 0) {
      if (kind === 'detail' && (width < 180 || height < 90)) return false;
      if (kind === 'main' && width < 70 && height < 70) return false;
      if (kind === 'sku' && width < 24 && height < 24) return false;
    }
    return true;
  };
  const collectImages = (selectors, kind, maximum) => {
    const rows = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const url = imageSource(element);
        if (usableImage(url, element, kind) && !rows.includes(url)) rows.push(url);
        if (rows.length >= maximum) return rows;
      }
    }
    return rows;
  };
  const mainImageSelectors = [
    '[data-wangzai-field="mainImages"] img', '[data-widget*="webGallery"] img',
    '[class*="offer-image"] img', '[class*="detail-gallery"] img', '[class*="image-gallery"] img',
    '[class*="image-list"] img', '[class*="ImageList"] img', '[class*="carousel"] img',
    '[class*="Carousel"] img', '[class*="preview"] img', '[class*="Preview"] img',
    '[class*="gallery"] img', '[class*="Gallery"] img', '[data-testid*="gallery"] img',
  ];
  const mainImages = [...new Set([
    ...platformProduct.mainImages,
    ...(hasStructuredProduct && platformProduct.mainImages.length ? [] : [
      ...imageValues.map(safeImageUrl).filter(url => usableImage(url, null, 'main')),
      safeImageUrl(meta('meta[property="og:image"]')),
       ...collectImages(mainImageSelectors, 'main', 60),
    ]),
  ].filter(url => usableImage(url, null, 'main'))) ].slice(0, 60);
  const skuImageSelectors = [
    '[data-wangzai-field="skuImages"] img', '[data-sku-id] img', '[data-sku] img',
    '[class*="sku"] img', '[class*="Sku"] img', '[class*="spec"] img', '[class*="Spec"] img',
    '[class*="variant"] img', '[class*="Variant"] img', '[class*="prop"] img', '[class*="color"] img',
  ];
  const skuImages = [...platformProduct.skuImages];
  for (const selector of hasStructuredProduct && (platformProduct.skuImages.length || platformProduct.skus.length) ? [] : skuImageSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const imageUrl = imageSource(element);
      if (!usableImage(imageUrl, element, 'sku')) continue;
      const container = element.closest?.('[data-sku-id], [data-sku], [data-prop-value], [class*="sku"], [class*="Sku"], [class*="spec"], [class*="Spec"], [class*="variant"], [class*="Variant"]') || element.parentElement;
      const skuId = clean(container?.getAttribute?.('data-sku-id') || container?.getAttribute?.('data-sku') || container?.getAttribute?.('data-prop-value'), 260);
      const skuName = clean(container?.getAttribute?.('title') || container?.getAttribute?.('aria-label') || textOf(container), 500);
      const key = `${skuId}|${skuName}|${imageUrl}`;
      if (!skuImages.some(row => `${row.skuId}|${row.skuName}|${row.imageUrl}` === key)) skuImages.push({ skuId, skuName, imageUrl });
      if (skuImages.length >= 800) break;
    }
    if (skuImages.length >= 800) break;
  }
  const detailImageSelectors = [
    '[data-wangzai-field="detailImages"] img', '[data-widget*="webDescription"] img',
    '[data-module*="description"] img', '#description img', '#desc-lazyload-container img',
    '[id*="description"] img', '[class*="detail-content"] img', '[class*="detailContent"] img',
    '[class*="description-content"] img', '[class*="descriptionContent"] img',
    '[class*="product-detail"] img', '[class*="ProductDetail"] img',
  ];
  const occupiedImages = new Set([...mainImages, ...skuImages.map(row => row.imageUrl)]);
  const detailImages = [...new Set([
    ...platformProduct.detailImages,
    ...(hasStructuredProduct && platformProduct.detailImages.length ? [] : collectImages(detailImageSelectors, 'detail', 300)),
  ])].filter(url => !occupiedImages.has(url)).slice(0, 300);
  const images = [...new Set([
    ...mainImages,
    ...skuImages.map(row => row.imageUrl),
    ...detailImages,
  ])].slice(0, 1200);
  const imageUrl = mainImages[0] || skuImages[0]?.imageUrl || '';
  const urlParams = new URLSearchParams(location.search);
  const sourceProductId = clean(
    platformProduct.sourceProductId || urlParams.get('id') || urlParams.get('goods_id') || urlParams.get('offerId') || urlParams.get('product_id') || urlParams.get('sku')
      || location.pathname.match(/(?:offer|item|goods)\/(\d{5,})/u)?.[1]
      || location.pathname.match(/^\/product\/[^/]*?(\d{5,})(?:\/|$)/u)?.[1]
      || location.pathname.match(/^\/t\/([^/]+)/u)?.[1]
      || productJson.sku || productJson.productID,
    260,
  );
  const description = clean(platformProduct.description || productJson.description || meta('meta[name="description"]') || meta('meta[property="og:description"]'), 8000);
  const skuSources = offerRows.length ? offerRows : skuImages.length ? skuImages : variant ? [{}] : [];
  const fallbackSkus = skuSources.map((offer, index) => ({
    id: clean(offer.sku || offer.skuId || offer.offerId || offer.productID || `${productJson.sku || productJson.productID || 'sku'}-${index + 1}`, 260),
    name: clean(offer.name || offer.skuName || variant || productTitle, 500),
    attributes: selectedVariants,
    price: clean(offer.price || amount, 80),
    imageUrl: safeImageUrl(offer.image || offer.imageUrl) || skuImages[index]?.imageUrl || imageUrl,
  })).slice(0, 800);
  const skus = (platformProduct.skus.length ? platformProduct.skus : fallbackSkus.length ? fallbackSkus : amount && sourceProductId ? [{
    id: sourceProductId, name: variant || productTitle, attributes: selectedVariants,
    price: amount, imageUrl,
  }] : []).slice(0, 800);
  const brand = clean(platformProduct.brand || (typeof productJson.brand === 'object' ? productJson.brand?.name : productJson.brand), 180);
  const breadcrumbCategory = unique([...document.querySelectorAll('[aria-label*="breadcrumb" i] a, nav[class*="breadcrumb" i] a, [class*="breadcrumb" i] a')]
    .filter(visible).map(textOf), 8).join(' > ');
  const category = clean(platformProduct.category || productJson.category || breadcrumbCategory, 500);
  const domOrder = first([
    '[data-wangzai-receipt-order]', '[data-order-number]', 'meta[name="purchase-order-number"]', ...(selectors.order || []),
  ], 260);
  const textOrder = labeled([
    /(?:订单编号|订单号码|订单号|交易号|交易编号|订单ID)\s*[:：]?\s*([A-Za-z0-9._:@/+\-=]{5,120})/u,
    /(?:Номер заказа|Заказ)\s*(?:№|#|:)?\s*([A-Za-zА-Яа-я0-9._:@/+\-=]{5,120})/iu,
  ], 260);
  const visibleOrderIds = [];
  if (taobaoOrderPage) {
    for (const element of document.querySelectorAll('[data-wangzai-receipt-order], [data-order-number], meta[name="purchase-order-number"], [data-order-id], [data-trade-id], [class*="order-number"]')) {
      if (!visible(element)) continue;
      const value = clean(element.getAttribute('data-wangzai-receipt-order') || element.getAttribute('data-order-number')
        || element.getAttribute('data-order-id') || element.getAttribute('data-trade-id') || textOf(element), 260);
      const id = value.match(/(?:^|[:：\s])([A-Za-z0-9._:@/+\-=]{5,120})(?:$|\s)/u)?.[1];
      if (id) visibleOrderIds.push(id);
    }
    for (const match of body.matchAll(/(?:订单编号|订单号码|订单号|交易号|交易编号|订单ID)\s*[:：]?\s*([A-Za-z0-9._:@/+\-=]{5,120})/gu)) visibleOrderIds.push(match[1]);
  }
  const exactVisibleIds = [...new Set(visibleOrderIds)];
  const orderNumber = taobaoOrderPage ? (urlOrder || exactVisibleIds[0] || textOrder) : (domOrder || urlOrder || textOrder);
  if (taobaoOrderPage && (exactVisibleIds.length > 1 || exactVisibleIds.some(id => id !== orderNumber))) {
    return JSON.stringify({
      extensionVersion: '1.4.0', runtimeKind: 'builtin', platform, pageType: 'order-detail',
      pageUrl: location.href, sourceUrl: location.href, purchaseOrderUrl: location.href,
      orderNumber: '', purchaseOrderNumber: '', amount: '', purchasePrice: null, currency: 'CNY',
      purchaseOrderStatus: '', paymentConfirmed: false, refundConfirmed: false,
      orderCaptureStatus: 'rejected', orderRejectionReasons: ['order-identity-mismatch'],
      capturedAt: new Date().toISOString(), fieldConfidence: { purchaseOrderNumber: 0, purchasePrice: 0 },
    });
  }
  const trackingNumber = first(['[data-tracking-number]', '[class*="tracking-number"]', '[class*="waybill"]'], 260)
    || labeled([/(?:物流单号|快递单号|运单号)\s*[:：]?\s*([A-Za-z0-9\-]{6,120})/u], 260);
  const carrierName = first(['[data-carrier-name]', '[class*="carrier-name"]', '[class*="express-company"]'], 120)
    || labeled([/(?:快递公司|物流公司|承运商)\s*[:：]?\s*([^\n]{2,40})/u], 120);
  const logisticsStatus = first(['[data-logistics-status]', '[class*="logistics-status"]'], 160)
    || labeled([/(?:物流状态|包裹状态)\s*[:：]?\s*([^\n]{2,80})/u], 160);
  const purchaseOrderStatus = first([
    '[data-wangzai-order-status]', '[data-order-status]', '[class*="order-status"]',
    '[class*="status-text"]', '[class*="statusText"]',
  ], 160) || labeled([
    /(?:订单状态|交易状态|付款状态|支付状态)\s*[:：]?\s*([^\n]{2,40})/u,
  ], 160) || clean(body.match(/(极速退款成功|退款成功|已退款|退款完成|退款处理中|申请退款|支付成功|买家已付款|已付款|待发货|等待商家发货|等待卖家发货|已发货|待收货|交易成功|已完成|待付款|等待付款|交易关闭|订单已关闭|已关闭|已取消)/u)?.[1], 160);
  const paymentConfirmed = Boolean(
    purchaseOrderStatus
    && /支付成功|买家已付款|已付款|待发货|等待商家发货|等待卖家发货|已发货|待收货|交易成功|已完成/u.test(purchaseOrderStatus)
    && !/待付款|等待付款|退款|关闭|取消/u.test(purchaseOrderStatus)
  );
  const refundConfirmed = Boolean(
    purchaseOrderStatus
    && /极速退款成功|退款成功|已退款|退款完成/u.test(purchaseOrderStatus)
    && !/申请退款|退款处理中|等待退款|退款审核|退款失败|退款关闭/u.test(purchaseOrderStatus)
  );
  const pageHaystack = `${document.title} ${body.slice(0, 5000)} ${location.pathname} ${location.search}`.toLowerCase();
  const explicitProductRoute = /\/offer\/\d+\.html|[?&](?:id|goods_id)=\d+|\/product\/[^/]*\d{5,}|\/dp\/[a-z0-9]+|\/catalog\/\d+\/detail|\/\d+\.html/u.test(`${location.pathname}${location.search}`.toLowerCase());
  // Marketplace product pages commonly render a "我的订单" navigation link.
  // That text must not turn an exact goods.html?goods_id=... page into an order
  // list. Conversely, checkout routes do not satisfy explicitProductRoute, so
  // a stale SPA product graph cannot be accepted after SKU confirmation.
  const pageType = sourceProductId && hasStructuredProduct && explicitProductRoute ? 'product'
    : /物流|运单|快递|logistics|tracking|express|доставк|отслежив/u.test(pageHaystack) ? 'logistics-detail'
    : /订单详情|交易详情|order.?detail|trade.?detail|заказ\s*№|номер заказа/u.test(pageHaystack) ? 'order-detail'
      : /我的订单|订单列表|order.?list|мои заказы/u.test(pageHaystack) ? 'order-list'
        : sourceProductId && (hasStructuredProduct || /商品详情|立即购买|加入购物车|в корзину/u.test(pageHaystack))
          ? 'product' : 'unknown';
  const titleNoise = /^(?:用户评价|累计评价|全部评价|商品评价|评论|买家评价)(?:[·:：\s]*\d+[+万]?)?$/u.test(productTitle)
    || /^(?:登录|立即登录|安全验证|访问受限|captcha|verify|sign\s*in|log\s*in)$/iu.test(productTitle);
  const rejectionReasons = [
    pageType !== 'product' ? 'not-product-page' : '',
    titleNoise || productTitle.length < 4 ? 'invalid-title' : '',
    !sourceProductId ? 'missing-product-id' : '',
    !amount ? 'missing-price' : '',
    !mainImages.length ? 'missing-main-image' : '',
    !skus.length ? 'missing-sku' : '',
  ].filter(Boolean);
  const captureStatus = rejectionReasons.length ? 'rejected' : 'accepted';
  const confidence = (value, strong = 0.9) => value ? strong : 0;
  return JSON.stringify({
    extensionVersion: '1.4.0', runtimeKind: 'builtin', platform, pageType,
    pageUrl: location.href, sourceUrl: location.href, pageTitle: clean(document.title, 300),
    productTitle, variant: clean(variant, 260), quantity: clean(quantity, 40), amount,
    purchasePrice: amount,
    purchasePriceMin: clean(platformProduct.purchasePriceMin || amount, 80),
    purchasePriceMax: clean(platformProduct.purchasePriceMax || platformProduct.purchasePriceMin || amount, 80),
    currency: clean(
      platformProduct.currency
        || offerJson.priceCurrency
        || meta('meta[property="product:price:currency"]')
        || (['1688', '淘宝', '天猫', '拼多多', '京东'].includes(platform) ? 'CNY' : '')
        || (['Ozon买家', 'Wildberries'].includes(platform) ? 'RUB' : ''),
      12,
    ),
    imageUrl, mainImages, skuImages, detailImages, images, videoUrl: platformProduct.videoUrl,
    description, attributes: platformProduct.attributes, skus, brand, category,
    sourceCategoryId: platformProduct.sourceCategoryId,
    sourceCategoryName: platformProduct.sourceCategoryName || category,
    sourceCategoryPath: platformProduct.sourceCategoryPath || platformProduct.sourceCategoryName || category,
    lengthCm, widthCm, heightCm, weightKg,
    weightG: platformProduct.weightG,
    weightMinG: platformProduct.weightMinG,
    weightMaxG: platformProduct.weightMaxG,
    shippingStatus: platformProduct.shippingStatus,
    shippingFeeMin: platformProduct.shippingFeeMin,
    shippingFeeMax: platformProduct.shippingFeeMax,
    shippingCurrency: platformProduct.shippingCurrency,
    shippingRuleText: platformProduct.shippingRuleText,
    minimumOrderQuantity: platformProduct.minimumOrderQuantity,
    minimumOrderUnit: platformProduct.minimumOrderUnit,
    mixedBatchStatus: platformProduct.mixedBatchStatus,
    perSkuMinimumQuantity: platformProduct.perSkuMinimumQuantity,
    purchaseMultiple: platformProduct.purchaseMultiple,
    deliveryLeadTimeHours: platformProduct.deliveryLeadTimeHours,
    deliveryText: platformProduct.deliveryText,
    packageDimensions: [lengthCm, widthCm, heightCm].every(value => Number.isFinite(value))
      ? `${lengthCm} × ${widthCm} × ${heightCm} cm` : clean(dimensionText, 180),
    packageWeight: Number.isFinite(weightKg) ? `${weightKg} kg` : clean(typeof rawWeight === 'object' ? rawWeight?.value : rawWeight, 100),
    orderNumber, purchaseOrderNumber: orderNumber, purchaseOrderStatus, orderStatus: purchaseOrderStatus,
    statusText: purchaseOrderStatus, paymentConfirmed, refundConfirmed, sourceProductId,
    trackingNumber, carrierName, logisticsStatus, status: purchaseOrderStatus || logisticsStatus,
    captureStatus, rejectionReasons, sourceMethod: platformProduct.sourceMethod || 'dom-fallback',
    fieldConfidence: {
      platform: platform === 'unknown' ? 0 : 1,
      productTitle: confidence(productTitle, productJson.name ? 0.98 : 0.88),
      variant: confidence(variant, 0.78), quantity: confidence(quantity, 0.82),
      purchaseOrderNumber: confidence(orderNumber, urlOrder ? 0.92 : 0.86),
      purchasePrice: confidence(amount, offerJson.price ? 0.96 : 0.84),
      packageDimensions: confidence([lengthCm, widthCm, heightCm].filter(Number.isFinite).length === 3, 0.82),
      packageWeight: confidence(weightKg, 0.82),
      trackingNumber: confidence(trackingNumber, 0.88),
    },
    inspectedAt: new Date().toISOString(),
  });
})()
""";
}
