export const PROFIT_LEDGER_PERSISTENCE_FORMAT = 'profit-ledger-compact-v1';
export const PROFIT_LEDGER_CHUNK_FORMAT = 'profit-ledger-chunk-v1';
export const PROFIT_LEDGER_CHUNKED_FORMAT = 'profit-ledger-chunked-v1';
export const PROFIT_LEDGER_CHUNK_TARGET_BYTES = 1024 * 1024;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => (
      item !== undefined &&
      item !== null &&
      item !== '' &&
      !(Array.isArray(item) && item.length === 0)
    ))
  );
}

function compactExchangeRate(value = null) {
  if (!isObject(value)) return null;
  return compactObject({
    mode: value.mode,
    base: value.base,
    quote: value.quote,
    rubToCnyRate: value.rubToCnyRate,
    requestedDate: value.requestedDate,
    effectiveDate: value.effectiveDate,
    source: value.source,
    status: value.status,
  });
}

function compactCrossBorderEvidence(value = null) {
  if (!isObject(value)) return null;
  return compactObject({
    source: value.source,
    collectionNumber: value.collectionNumber,
    collectionNumbers: value.collectionNumbers,
    internalOrderId: value.internalOrderId,
    postingNumber: value.postingNumber,
    sourceHash: value.sourceHash,
    actualFeeCny: value.actualFeeCny,
  });
}

function compactPenaltyRecord(value = null) {
  if (!isObject(value)) return null;
  return compactObject({
    schemaVersion: value.schemaVersion,
    dedupeKey: value.dedupeKey,
    status: value.status,
    operationId: value.operationId,
    postingNumber: value.postingNumber,
    orderId: value.orderId,
    shopId: value.shopId,
    shopClientId: value.shopClientId,
    operationType: value.operationType,
    operationName: value.operationName,
    operationDate: value.operationDate,
    amountCny: value.amountCny,
    currencyCode: value.currencyCode,
    reason: value.reason,
    source: value.source,
  });
}

function compactLedgerAmount(value = null, field = '') {
  if (!isObject(value)) return value;
  const status = value.status || 'pending';
  const compact = {
    value: value.value ?? null,
    status,
    source: value.source || '',
    ...(status === 'ready' || !value.reason ? {} : { reason: value.reason }),
  };
  if (field === 'actualCrossBorderBusFeeCny') {
    const evidence = compactCrossBorderEvidence(value.evidence);
    if (evidence && Object.keys(evidence).length) compact.evidence = evidence;
  }
  return compact;
}

function compactLedgerResult(value = null) {
  if (!isObject(value)) return value;
  const status = value.status || 'pending';
  return compactObject({
    value: value.value ?? null,
    status,
    reason: status === 'ready' ? '' : value.reason,
    missing: status === 'ready' ? [] : value.missing,
    formula: value.formula,
  });
}

function compactProduct(value = {}) {
  const image = value.image || value.skuImage || value.primaryImage || value.images?.[0] || '';
  return compactObject({
    name: value.name,
    qty: value.qty,
    salesAmountValue: value.salesAmountValue,
    currencyCode: value.currencyCode,
    commissionPercent: value.commissionPercent,
    commissionMode: value.commissionMode,
    offerId: value.offerId,
    sku: value.sku,
    skuId: value.skuId,
    productId: value.productId,
    weight: value.weight || value.materialProfile?.weight,
    length: value.length || value.materialProfile?.length,
    width: value.width || value.materialProfile?.width,
    height: value.height || value.materialProfile?.height,
    image,
  });
}

function compactOrderSnapshot(value = {}) {
  return compactObject({
    posting: value.posting || value.id,
    salesOrder: value.salesOrder,
    softwareOrderId: value.softwareOrderId,
    shop: value.shop,
    status: value.status || value.statusLabel,
    rawSubstatus: value.rawSubstatus,
    afterSalesStatus: value.afterSalesStatus,
    cancelledAfterShip: value.cancelledAfterShip,
    hasAfterSalesRefund: value.hasAfterSalesRefund,
    hasFinanceRefund: value.hasFinanceRefund,
    partialCompensationOnly: value.partialCompensationOnly,
    product: value.product,
    qty: value.qty,
    paymentDate: value.paymentDate || value.paymentTime,
    fulfillment: value.fulfillment,
    purchasePlatform: value.purchasePlatform,
    purchaseOrderNo: value.purchaseOrderNo,
    purchaseOrderUrl: value.purchaseOrderUrl,
    sourcePurchaseCostCny: value.sourcePurchaseCostCny,
    currencyCode: value.currencyCode,
    sourceCurrencyCode: value.sourceCurrencyCode,
    products: (Array.isArray(value.products) ? value.products : []).slice(0, 2).map(compactProduct),
  });
}

function compactLedgerRow(value = {}) {
  const estimatedRate = compactExchangeRate(
    value.exchangeRates?.estimated || value.estimatedExchangeRate || value.exchangeRate
  );
  const actualRate = compactExchangeRate(value.exchangeRates?.actual || value.actualExchangeRate);
  const penaltyDetails = (Array.isArray(value.penaltyDetails) ? value.penaltyDetails : [])
    .map(compactPenaltyRecord)
    .filter(Boolean);
  return compactObject({
    schemaVersion: value.schemaVersion,
    calculationVersion: value.calculationVersion,
    ledgerKey: value.ledgerKey || value.orderKey,
    shopId: value.shopId,
    shopClientId: value.shopClientId,
    actualFinanceStatus: value.actualFinanceStatus,
    hasActualFinance: value.hasActualFinance,
    financeOperationCount: value.financeOperationCount,
    afterSalesCount: value.afterSalesCount,
    profitFinanceVersion: value.profitFinanceVersion,
    financeLookupChecked: value.financeLookupChecked,
    financeReadbackState: value.financeReadbackState,
    financeEmptyReceipt: isObject(value.financeEmptyReceipt) ? compactObject({
      version: value.financeEmptyReceipt.version, source: value.financeEmptyReceipt.source,
      scope: value.financeEmptyReceipt.scope, shopId: value.financeEmptyReceipt.shopId,
      clientId: value.financeEmptyReceipt.clientId, postingNumbers: value.financeEmptyReceipt.postingNumbers,
      operationCount: value.financeEmptyReceipt.operationCount, checkedAt: value.financeEmptyReceipt.checkedAt,
    }) : null,
    exchangeRates: compactObject({ estimated: estimatedRate, actual: actualRate }),
    orderSnapshot: compactOrderSnapshot(value.orderSnapshot),
    amounts: Object.fromEntries(
      Object.entries(value.amounts || {}).map(([field, amount]) => [
        field,
        compactLedgerAmount(amount, field),
      ])
    ),
    results: Object.fromEntries(
      Object.entries(value.results || {}).map(([field, result]) => [field, compactLedgerResult(result)])
    ),
    penaltyDetails,
    status: value.status,
  });
}

export function compactProfitLedgerSnapshotForPersistence(snapshot = {}) {
  if (!isObject(snapshot)) return snapshot;
  const penaltyDetails = Object.fromEntries(
    Object.entries(isObject(snapshot.penaltyDetails) ? snapshot.penaltyDetails : {})
      .map(([key, value]) => [key, compactPenaltyRecord(value)])
      .filter(([, value]) => Boolean(value))
  );
  return {
    ...snapshot,
    persistenceFormat: PROFIT_LEDGER_PERSISTENCE_FORMAT,
    rows: (Array.isArray(snapshot.rows) ? snapshot.rows : []).map(compactLedgerRow),
    penaltyDetails,
  };
}

export function createProfitLedgerPersistencePlan(snapshot = {}, options = {}) {
  const compact = compactProfitLedgerSnapshotForPersistence(snapshot);
  const targetBytes = Math.max(
    64 * 1024,
    Math.floor(Number(options.targetBytes) || PROFIT_LEDGER_CHUNK_TARGET_BYTES)
  );
  const rows = Array.isArray(compact?.rows) ? compact.rows : [];
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + (current.length ? 1 : 0);
    if (current.length && currentBytes + rowBytes > targetBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length || !chunks.length) chunks.push(current);

  const { rows: _ignoredRows, ...metadata } = compact;
  return {
    manifest: {
      ...metadata,
      persistenceFormat: PROFIT_LEDGER_CHUNKED_FORMAT,
      rows: [],
      rowCount: rows.length,
      chunkKeys: [],
    },
    chunks: chunks.map((chunkRows, index) => ({
      persistenceFormat: PROFIT_LEDGER_CHUNK_FORMAT,
      calculationVersion: compact.calculationVersion,
      chunkIndex: index,
      chunkCount: chunks.length,
      rowCount: chunkRows.length,
      rows: chunkRows,
    })),
    rowCount: rows.length,
  };
}
