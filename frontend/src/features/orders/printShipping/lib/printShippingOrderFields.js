const EMPTY_VALUES = new Set(['', '-', '--', '未返回', '待补录', 'null', 'undefined']);

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function firstUseful(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text && !EMPTY_VALUES.has(text) && !EMPTY_VALUES.has(text.toLowerCase())) return text;
  }
  return '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function platformLabel(value) {
  const text = firstUseful(value);
  const normalized = text.toLowerCase();
  if (!text) return '待关联';
  if (normalized === '1' || normalized === '1688') return '1688';
  if (normalized === '2' || normalized === 'taobao' || normalized === 'tmall') return '淘宝 / 天猫';
  if (normalized === '3' || normalized === 'pdd') return '拼多多';
  return text;
}

function getNestedSources(source = {}) {
  const safeSource = asObject(source);
  const raw = asObject(safeSource.raw);
  const sheetInfo = asObject(safeSource.sheet_info || safeSource.sheetInfo);
  const packages = Array.isArray(safeSource.package_list)
    ? safeSource.package_list.filter((item) => item && typeof item === 'object')
    : [];
  return [safeSource, raw, sheetInfo, ...packages];
}

function firstFromSources(sources = [], fields = []) {
  return firstUseful(...sources.flatMap((source) => fields.map((field) => source?.[field])));
}

export function resolvePrintShippingOrderFields(order = {}, shippingContext = {}) {
  const safeOrder = asObject(order);
  const orderRaw = asObject(safeOrder.raw);
  const purchaseInfo = asObject(shippingContext.purchaseInfo);
  const purchaseOverride = asObject(shippingContext.purchaseOverride);
  const crossBorderRecord = asObject(purchaseOverride.crossBorderRecord);
  const domesticSources = [
    ...getNestedSources(purchaseOverride),
    ...getNestedSources(crossBorderRecord),
  ];
  const ozonSources = [safeOrder, orderRaw, asObject(orderRaw.posting), asObject(orderRaw.result)];

  const sourcePlatform = platformLabel(firstUseful(
    purchaseInfo.platform,
    firstFromSources(domesticSources, ['purchasePlatform', 'purchase_platform', 'platform', 'from_platform'])
  ));
  const purchaseOrderNumber = firstUseful(
    purchaseInfo.orderNumber,
    firstFromSources(domesticSources, [
      'purchaseOrderNumber',
      'purchase_order_number',
      'purchaseOrderNo',
      'purchase_order_no',
      'fromOrder',
      'from_order',
    ])
  );
  const domesticTrackingNumber = firstFromSources(domesticSources, [
    'trackingNumber',
    'tracking_number',
    'logisticsOrder',
    'logistics_order',
  ]);
  const ozonTrackingNumber = firstUseful(
    firstFromSources(ozonSources, ['trackingNumber', 'tracking_number', 'barcode', 'barcode_number']),
    firstFromSources(getNestedSources(crossBorderRecord), [
      'sheetOrderNumber',
      'sheet_order_sn',
      'sheetOrderSn',
    ])
  );

  return {
    sourcePlatform,
    purchaseOrderNumber: purchaseOrderNumber || '待关联',
    domesticTrackingNumber: domesticTrackingNumber || '待同步',
    ozonTrackingNumber: ozonTrackingNumber || '待 Ozon 返回',
  };
}

