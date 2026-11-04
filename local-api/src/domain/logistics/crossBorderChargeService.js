import { randomUUID } from 'node:crypto';
import { createCrossBorderChargeRepository } from '../../db/repositories/crossBorderChargeRepository.js';
import { createCrossBorderOrderRepository } from '../../db/repositories/crossBorderOrderRepository.js';
import { createOrderRepository } from '../../db/repositories/orderRepository.js';
import { createPurchaseOrderOverrideRepository } from '../../db/repositories/purchaseOrderOverrideRepository.js';
import { createProfileSettingsRepository } from '../../db/repositories/profileSettingsRepository.js';
import { createStableHash } from '../../utils/stableHash.js';
import {
  aggregateCrossBorderOrderCharges,
  inferCrossBorderChargeDirection,
  summarizeCrossBorderLedger,
} from './crossBorderChargeAccounting.js';
import {
  compactCrossBorderRechargePolicy,
  createCrossBorderRechargePolicy,
  resolveCrossBorderCashRate,
} from './crossBorderChargeConversion.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_SOURCE_ROWS = 100000;
const MAX_SOURCE_ORDERS = 100000;
const OZON_POSTING_LOOKUP_CHUNK_SIZE = 300;

function normalizeText(value, maximum = 500) {
  const text = value == null ? '' : String(value).trim();
  return text.slice(0, maximum);
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.+-]/gu, ''));
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeSourceOrder(input = {}) {
  return {
    internalOrderId: firstText(input.internalOrderId, input.internal_order_id, input.id),
    collectionNumber: firstText(input.collectionNumber, input.collection_number, input.oid),
    postingNumber: firstText(input.postingNumber, input.posting_number, input.orderNumber, input.order_number),
    purchaseOrderNumber: firstText(
      input.purchaseOrderNumber,
      input.purchase_order_number,
      input.fromOrder,
      input.from_order,
    ),
    trackingNumber: firstText(input.trackingNumber, input.tracking_number, input.logisticsOrder, input.logistics_order),
    sheetOrderSn: firstText(input.sheetOrderSn, input.sheet_order_sn),
    serviceName: firstText(input.serviceName, input.service_name, input.service),
    warehouse: firstText(input.warehouse, input.storehouseName, input.storehouse_name),
    orderStatus: firstText(input.orderStatus, input.order_status, input.status),
    packageWeightKg: normalizeMoney(input.packageWeightKg ?? input.package_weight_kg ?? input.weight),
    detailTotalCny: normalizeMoney(input.detailTotalCny ?? input.detail_total_cny ?? input.totalFeeCny),
    feeBreakdown: input.feeBreakdown && typeof input.feeBreakdown === 'object' ? input.feeBreakdown : {},
  };
}

function normalizeSourceCharge(input = {}) {
  const direction = inferCrossBorderChargeDirection(input);
  const rawAmountCny = normalizeMoney(input.amountCny ?? input.amount_cny ?? input.money);
  const amountCny = rawAmountCny === null ? null : Math.abs(rawAmountCny);
  const collectionNumber = firstText(input.collectionNumber, input.collection_number, input.oid);
  if (!direction || amountCny === null || amountCny < 0 || !collectionNumber) return null;
  return {
    collectionNumber,
    direction,
    amountCny,
    balanceAfterCny: normalizeMoney(input.balanceAfterCny ?? input.balance_after_cny ?? input.afterMoney ?? input.after_money),
    reason: normalizeText(input.reason, 300),
    occurredAt: firstText(input.occurredAt, input.occurred_at, input.time),
    warehouse: firstText(input.warehouse, input.storehoursName, input.storehours_name),
    serviceCompany: firstText(input.serviceCompany, input.service_company, input.brandName, input.brand_name),
  };
}

function groupCharges(charges = []) {
  const groups = new Map();
  charges.forEach((charge) => {
    if (!charge) return;
    const rows = groups.get(charge.collectionNumber) || [];
    rows.push(charge);
    groups.set(charge.collectionNumber, rows);
  });
  return groups;
}

function buildMatchIndex(orderRows = []) {
  const byPosting = new Map();
  orderRows.forEach((row) => {
    const postingNumber = normalizeText(row.postingNumber ?? row.posting_number, 180);
    if (!postingNumber) return;
    const key = postingNumber.toLowerCase();
    const rows = byPosting.get(key) || [];
    rows.push({
      shopId: normalizeText(row.shopId ?? row.shop_id, 180),
      postingNumber,
      orderKey: normalizeText(row.orderKey ?? row.order_key, 180) || postingNumber,
      orderId: normalizeText(row.orderId ?? row.order_id, 180),
    });
    byPosting.set(key, rows);
  });
  return byPosting;
}

function normalizeBrowserAccountRef(input = {}) {
  return firstText(
    input.browserAccountRef,
    input.browser_account_ref,
    input.storageRef,
    input.accountId,
    input.account_id,
  );
}

function previewPublicRow(row = {}) {
  return {
    crossBorderAccountId: row.crossBorderAccountId,
    collectionNumber: row.collectionNumber,
    postingNumber: row.postingNumber,
    purchaseOrderNumber: row.purchaseOrderNumber,
    shopId: row.shopId,
    ozonOrderKey: row.ozonOrderKey,
    matchStatus: row.matchStatus,
    confidence: row.confidence,
    actualFeeCny: row.actualFeeCny,
    ledgerNetCny: row.ledgerNetCny,
    expenseCny: row.expenseCny,
    incomeCny: row.incomeCny,
    cashExpenseCny: row.cashExpenseCny,
    cashIncomeCny: row.cashIncomeCny,
    cashNetCny: row.cashNetCny,
    conversionConfigured: row.conversionPolicy?.configured === true,
    conversionRate: row.conversionPolicy?.defaultRate ?? 1,
    serviceName: row.serviceName,
    warehouse: row.warehouse,
    statementCount: row.statements.length,
    candidateShopIds: row.candidateShopIds,
  };
}

function buildExactOrderGroups(rows = []) {
  return aggregateCrossBorderOrderCharges(rows).map((group) => ({
    ...group,
    sourceHash: createStableHash({
      shopId: group.shopId,
      orderKey: group.orderKey,
      collections: group.collections,
      expenseCny: group.expenseCny,
      incomeCny: group.incomeCny,
      ledgerNetCny: group.ledgerNetCny,
      cashExpenseCny: group.cashExpenseCny,
      cashIncomeCny: group.cashIncomeCny,
      cashNetCny: group.cashNetCny,
      actualFeeCny: group.actualFeeCny,
    }, { length: 40 }),
  }));
}

function readOzonOrderKeys(orderRepository, postingNumbers = [], allowedShopIds = []) {
  if (!postingNumbers.length || !allowedShopIds.length) return [];
  const rows = [];
  const seen = new Set();
  for (let offset = 0; offset < postingNumbers.length; offset += OZON_POSTING_LOOKUP_CHUNK_SIZE) {
    const chunk = postingNumbers.slice(offset, offset + OZON_POSTING_LOOKUP_CHUNK_SIZE);
    let page = 1;
    while (true) {
      const result = orderRepository.listOrders({
        shopIds: allowedShopIds,
        postingNumbers: chunk,
        page,
        pageSize: 1000,
        projection: 'keys',
      });
      const pageRows = Array.isArray(result?.rows) ? result.rows : [];
      pageRows.forEach((row) => {
        const key = [row.shopId, row.orderKey, row.postingNumber, row.orderId]
          .map((value) => normalizeText(value, 180)).join('\u001f');
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(row);
        }
      });
      const total = Math.max(Number(result?.total) || 0, 0);
      if (!pageRows.length || page * 1000 >= total) break;
      page += 1;
      if (page > 1000) throw new Error('CROSS_BORDER_CHARGE_LOCAL_MATCH_INCOMPLETE');
    }
  }
  return rows;
}

export function buildCrossBorderOrderOverridePatch(group, timestamp, existing = {}) {
  const first = group.rows[0] || {};
  const orderKey = group.ozonOrderKey || group.postingNumber;
  return {
    ...existing,
    shopId: group.shopId,
    orderKey,
    postingNumber: group.postingNumber,
    purchaseOrderNumber: group.purchaseOrderNumbers[0] || existing.purchaseOrderNumber,
    crossBorderOrderFound: true,
    crossBorderOrderCount: group.collectionNumbers.length,
    packageOrderId: group.internalOrderIds[0] || group.collectionNumbers[0] || existing.packageOrderId,
    packageOrderIds: group.internalOrderIds.length
      ? group.internalOrderIds
      : group.collectionNumbers.length
        ? group.collectionNumbers
        : existing.packageOrderIds,
    crossBorderOrderId: group.internalOrderIds[0] || group.collectionNumbers[0] || existing.crossBorderOrderId,
    crossBorderOrderNumber: group.collectionNumbers[0] || existing.crossBorderOrderNumber,
    sheetOrderSn: first.sheetOrderSn || existing.sheetOrderSn || group.postingNumber,
    warehouse: first.warehouse || existing.warehouse,
    packageWeight: first.packageWeightKg ?? existing.packageWeight,
    actualCrossBorderBusFeeCny: group.actualFeeCny,
    actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
    crossBorderChargeEvidence: {
      source: 'cross-border-bus-ledger-cash-converted',
      crossBorderAccountId: group.crossBorderAccountIds[0] || '',
      crossBorderAccountIds: group.crossBorderAccountIds,
      browserAccountRef: group.browserAccountRefs[0] || '',
      browserAccountRefs: group.browserAccountRefs,
      externalAccountRef: group.externalAccountRefs[0] || '',
      externalAccountRefs: group.externalAccountRefs,
      collectionNumber: group.collectionNumbers[0] || '',
      collectionNumbers: group.collectionNumbers,
      internalOrderId: group.internalOrderIds[0] || '',
      internalOrderIds: group.internalOrderIds,
      postingNumber: group.postingNumber,
      sourceHash: group.sourceHash,
      statementCount: group.statementCount,
      expenseCny: group.expenseCny,
      incomeCny: group.incomeCny,
      ledgerNetCny: group.ledgerNetCny,
      balanceNetCny: group.ledgerNetCny,
      cashExpenseCny: group.cashExpenseCny,
      cashIncomeCny: group.cashIncomeCny,
      cashNetCny: group.cashNetCny,
      actualFeeCny: group.actualFeeCny,
      conversionPolicy: group.conversionPolicy || first.conversionPolicy || {},
      collections: group.collections,
      updatedAt: timestamp,
    },
    crossBorderUpdatedAt: timestamp,
  };
}

export function createCrossBorderChargeService({
  db,
  shopRepository,
  crossBorderAccountService,
  profileSettingsRepository: providedProfileSettingsRepository,
  profileId = 'default',
  now = () => Date.now(),
  createPreviewId = () => `cross_border_charge_preview_${randomUUID()}`,
  createConfirmationToken = () => randomUUID(),
} = {}) {
  if (!db || !shopRepository?.listShops) throw new Error('CROSS_BORDER_CHARGE_SERVICE_NOT_CONNECTED');
  const chargeRepository = createCrossBorderChargeRepository(db, { profileId });
  const orderRepository = createOrderRepository(db);
  const crossBorderOrderRepository = createCrossBorderOrderRepository(db);
  const purchaseOverrideRepository = createPurchaseOrderOverrideRepository(db);
  const profileSettingsRepository = providedProfileSettingsRepository || createProfileSettingsRepository(db);
  const previews = new Map();

  function readRechargePolicy() {
    const setting = profileSettingsRepository.getSetting('fee-settings');
    return createCrossBorderRechargePolicy(setting?.value || {}, { updatedAt: setting?.updatedAt || '' });
  }

  function ledgerOptions(policy) {
    return {
      resolveCashRate: (occurredAt) => resolveCrossBorderCashRate(policy, occurredAt),
    };
  }

  function prunePreviews() {
    const timestamp = now();
    for (const [previewId, preview] of previews) {
      if (preview.expiresAt <= timestamp) previews.delete(previewId);
    }
  }

  function buildPreview(input = {}, requestContext = {}) {
    prunePreviews();
    const browserAccountRef = normalizeBrowserAccountRef(input);
    if (!browserAccountRef) throw new Error('CROSS_BORDER_BROWSER_ACCOUNT_REQUIRED');
    const externalAccountRef = firstText(input.externalAccountRef, input.external_account_ref, input.userCode);
    const sourceOrders = (Array.isArray(input.orders) ? input.orders : [])
      .slice(0, MAX_SOURCE_ORDERS)
      .map(normalizeSourceOrder)
      .filter((row) => row.collectionNumber || row.postingNumber);
    const sourceCharges = (Array.isArray(input.charges) ? input.charges : [])
      .slice(0, MAX_SOURCE_ROWS)
      .map(normalizeSourceCharge)
      .filter(Boolean);
    if (!sourceCharges.length) throw new Error('CROSS_BORDER_CHARGE_ROWS_REQUIRED');

    const orderByCollection = new Map(sourceOrders.map((row) => [row.collectionNumber, row]));
    const chargeGroups = groupCharges(sourceCharges);
    const rechargePolicy = readRechargePolicy();
    const compactPolicy = compactCrossBorderRechargePolicy(rechargePolicy);
    const postingNumbers = [...new Set(sourceOrders.map((row) => row.postingNumber).filter(Boolean))];
    // Resolve the shop universe through the same tenant/user/profile scope as
    // the charge preview.  A posting number is not enough to identify a shop
    // when several users share one local-api database; never match against a
    // different principal's shop just because the number happens to repeat.
    let scopedShops;
    try {
      scopedShops = typeof shopRepository.listShopsForContext === 'function'
        ? shopRepository.listShopsForContext(requestContext)
        : shopRepository.listShops();
    } catch (error) {
      if (error?.code === 'SHOP_SCOPE_FORBIDDEN') {
        throw new Error('CROSS_BORDER_CHARGE_SHOP_FORBIDDEN');
      }
      throw error;
    }
    const configuredShopIds = scopedShops.map((shop) => normalizeText(shop.id, 180)).filter(Boolean);
    const accountScope = crossBorderAccountService?.resolveAccountShopScope
      ? crossBorderAccountService.resolveAccountShopScope(input)
      : { ok: true, configured: false, ambiguous: false, accountId: '', shopIds: [] };
    if (accountScope?.ambiguous) {
      throw new Error('CROSS_BORDER_ACCOUNT_AMBIGUOUS');
    }
    const crossBorderAccountId = normalizeText(accountScope?.accountId, 180);
    const boundShopIds = [...new Set((Array.isArray(accountScope?.shopIds) ? accountScope.shopIds : [])
      .map((shopId) => normalizeText(shopId, 180))
      .filter(Boolean))];
    if (accountScope?.configured && boundShopIds.length === 0) {
      throw new Error('CROSS_BORDER_ACCOUNT_SHOPS_REQUIRED');
    }
    const boundShopIdSet = new Set(boundShopIds);
    const accountScopedShopIds = accountScope?.configured
      ? configuredShopIds.filter((shopId) => boundShopIdSet.has(shopId))
      : configuredShopIds;
    const requestedShopId = firstText(input.shopId, input.shop_id, requestContext.shopId);
    if (requestedShopId && !configuredShopIds.includes(requestedShopId)) {
      throw new Error('CROSS_BORDER_CHARGE_SHOP_FORBIDDEN');
    }
    if (requestedShopId && accountScope?.configured && !boundShopIdSet.has(requestedShopId)) {
      throw new Error('CROSS_BORDER_ACCOUNT_SHOP_FORBIDDEN');
    }
    const allowedShopIds = requestedShopId ? [requestedShopId] : accountScopedShopIds;
    const ozonRows = readOzonOrderKeys(orderRepository, postingNumbers, allowedShopIds);
    const matchIndex = buildMatchIndex(ozonRows);
    const rows = [...chargeGroups.entries()].map(([collectionNumber, statements]) => {
      const sourceOrder = orderByCollection.get(collectionNumber) || {};
      const postingNumber = normalizeText(sourceOrder.postingNumber, 180);
      const candidates = postingNumber ? (matchIndex.get(postingNumber.toLowerCase()) || []) : [];
      const uniqueCandidates = [...new Map(candidates.map((candidate) => [
        `${candidate.shopId}\u001f${candidate.orderKey}`,
        candidate,
      ])).values()];
      const matchStatus = uniqueCandidates.length === 1 ? 'exact' : uniqueCandidates.length > 1 ? 'ambiguous' : 'unmatched';
      const matched = matchStatus === 'exact' ? uniqueCandidates[0] : {};
      const ledger = summarizeCrossBorderLedger(statements, ledgerOptions(rechargePolicy));
      // “实际扣费”只认消费流水净额。收费明细可作为证据展示，不能在流水净额为 0
      // （例如取消、重发互相冲销）时反向伪造一笔已扣费用。
      const actualFeeCny = ledger.actualFeeCny;
      const sourceHash = createStableHash({
        browserAccountRef,
        crossBorderAccountId,
        externalAccountRef,
        collectionNumber,
        postingNumber,
        statements,
        conversionPolicy: compactPolicy,
        conversions: ledger.conversions,
        actualFeeCny,
        matchStatus,
        shopId: matched.shopId || '',
      }, { length: 40 });
      return {
        browserAccountRef,
        crossBorderAccountId,
        externalAccountRef,
        collectionNumber,
        postingNumber,
        purchaseOrderNumber: sourceOrder.purchaseOrderNumber || '',
        internalOrderId: sourceOrder.internalOrderId || '',
        trackingNumber: sourceOrder.trackingNumber || '',
        sheetOrderSn: sourceOrder.sheetOrderSn || '',
        serviceName: sourceOrder.serviceName || '',
        warehouse: sourceOrder.warehouse || statements[0]?.warehouse || '',
        orderStatus: sourceOrder.orderStatus || '',
        packageWeightKg: sourceOrder.packageWeightKg,
        detailTotalCny: sourceOrder.detailTotalCny,
        feeBreakdown: sourceOrder.feeBreakdown || {},
        statements,
        ...ledger,
        actualFeeCny,
        matchStatus,
        confidence: matchStatus === 'exact' ? 100 : 0,
        shopId: matched.shopId || '',
        ozonOrderKey: matched.orderKey || '',
        ozonOrderId: matched.orderId || '',
        candidateShopIds: [...new Set(uniqueCandidates.map((candidate) => candidate.shopId).filter(Boolean))],
        sourceHash,
      };
    });

    const exactOrderGroups = buildExactOrderGroups(rows);
    const previewId = createPreviewId();
    const confirmationToken = createConfirmationToken();
    const context = chargeRepository.normalizeScope({ ...requestContext, profileId });
    const preview = {
      previewId,
      confirmationToken,
      context,
      browserAccountRef,
      crossBorderAccountId,
      boundShopIds,
      externalAccountRef,
      requestedShopId,
      rows,
      exactOrderGroups,
      createdAt: now(),
      expiresAt: now() + PREVIEW_TTL_MS,
    };
    previews.set(previewId, preview);
    return {
      ok: true,
      previewId,
      confirmationToken,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      requiresConfirmation: true,
      summary: {
        crossBorderAccountId,
        boundShopCount: boundShopIds.length,
        sourceOrderCount: sourceOrders.length,
        statementCount: sourceCharges.length,
        orderCount: rows.length,
        exactCount: rows.filter((row) => row.matchStatus === 'exact').length,
        exactOrderCount: exactOrderGroups.length,
        unmatchedCount: rows.filter((row) => row.matchStatus === 'unmatched').length,
        ambiguousCount: rows.filter((row) => row.matchStatus === 'ambiguous').length,
        exactActualFeeCny: Math.round(exactOrderGroups
          .reduce((sum, row) => sum + row.actualFeeCny, 0) * 100) / 100,
        exactBalanceNetCny: Math.round(exactOrderGroups
          .reduce((sum, row) => sum + row.ledgerNetCny, 0) * 100) / 100,
        conversionConfigured: rechargePolicy.configured,
        conversionRate: rechargePolicy.defaultRate,
      },
      rows: rows.map(previewPublicRow),
    };
  }

  function persistExactCollectionProjection(row, timestamp) {
    crossBorderOrderRepository.upsertRecord({
      shopId: row.shopId,
      recordKey: row.collectionNumber || row.postingNumber,
      orderId: row.internalOrderId || row.collectionNumber,
      platformOrder: row.postingNumber,
      purchaseOrderNumber: row.purchaseOrderNumber,
      collectionNumber: row.collectionNumber,
      trackingNumber: row.trackingNumber,
      sheetOrderNumber: row.sheetOrderSn,
      status: row.orderStatus,
      warehouse: row.warehouse,
      packageWeightKg: row.packageWeightKg,
      actualCrossBorderBusFeeCny: row.actualFeeCny,
      actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
      crossBorderChargeEvidence: {
        source: 'cross-border-bus-ledger-cash-converted',
        crossBorderAccountId: row.crossBorderAccountId,
        sourceHash: row.sourceHash,
        statementCount: row.statements.length,
        expenseCny: row.expenseCny,
        incomeCny: row.incomeCny,
        ledgerNetCny: row.ledgerNetCny,
        balanceNetCny: row.ledgerNetCny,
        cashExpenseCny: row.cashExpenseCny,
        cashIncomeCny: row.cashIncomeCny,
        cashNetCny: row.cashNetCny,
        actualFeeCny: row.actualFeeCny,
        conversionPolicy: row.conversionPolicy,
        conversions: row.conversions,
        updatedAt: timestamp,
      },
    });

  }

  function persistExactOrderProjection(group, timestamp) {
    const orderKey = group.ozonOrderKey || group.postingNumber;
    const existing = purchaseOverrideRepository.getOverride({ shopId: group.shopId, orderKey }) || {};
    purchaseOverrideRepository.upsertOverride(buildCrossBorderOrderOverridePatch(group, timestamp, existing));
  }

  function confirmImport(input = {}, requestContext = {}) {
    prunePreviews();
    const previewId = normalizeText(input.previewId ?? input.preview_id, 180);
    const confirmationToken = normalizeText(input.confirmationToken ?? input.confirmation_token, 180);
    const preview = previews.get(previewId);
    if (!preview || preview.expiresAt <= now()) throw new Error('CROSS_BORDER_CHARGE_PREVIEW_EXPIRED');
    if (!confirmationToken || confirmationToken !== preview.confirmationToken) {
      throw new Error('CROSS_BORDER_CHARGE_CONFIRMATION_INVALID');
    }
    const currentContext = chargeRepository.normalizeScope({ ...requestContext, profileId });
    if (createStableHash(currentContext) !== createStableHash(preview.context)) {
      throw new Error('CROSS_BORDER_CHARGE_CONTEXT_MISMATCH');
    }
    const timestamp = new Date(now()).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      preview.rows.forEach((row) => {
        chargeRepository.upsertChargeRecords(row.statements.map((statement) => ({
          ...statement,
          browserAccountRef: row.browserAccountRef,
          crossBorderAccountId: row.crossBorderAccountId,
          externalAccountRef: row.externalAccountRef,
          shopId: row.shopId,
          postingNumber: row.postingNumber,
          purchaseOrderNumber: row.purchaseOrderNumber,
        })), preview.context);
      });
      chargeRepository.upsertChargeLinks(preview.rows.map((row) => ({
        ...row,
        evidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          crossBorderAccountId: row.crossBorderAccountId,
          sourceHash: row.sourceHash,
          internalOrderId: row.internalOrderId,
          statementCount: row.statements.length,
          expenseCny: row.expenseCny,
          incomeCny: row.incomeCny,
          cashExpenseCny: row.cashExpenseCny,
          cashIncomeCny: row.cashIncomeCny,
          cashNetCny: row.cashNetCny,
          actualFeeCny: row.actualFeeCny,
          conversionPolicy: row.conversionPolicy,
          conversions: row.conversions,
          feeBreakdown: row.feeBreakdown,
          detailTotalCny: row.detailTotalCny,
          candidateShopIds: row.candidateShopIds,
          capturedAt: timestamp,
        },
        lastSeenAt: timestamp,
      })), preview.context);
      preview.rows.filter((row) => row.matchStatus === 'exact')
        .forEach((row) => persistExactCollectionProjection(row, timestamp));
      preview.exactOrderGroups.forEach((group) => persistExactOrderProjection(group, timestamp));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    previews.delete(previewId);
    const readback = chargeRepository.listChargeLinks({
      browserAccountRef: preview.browserAccountRef,
      crossBorderAccountId: preview.crossBorderAccountId,
      limit: Math.max(preview.rows.length * 2, 20),
    }, preview.context);
    const sourceHashes = new Set(readback.rows.map((row) => row.sourceHash));
    const readbackVerified = preview.rows.every((row) => sourceHashes.has(row.sourceHash));
    return {
      ok: readbackVerified,
      previewId,
      committed: true,
      readbackVerified,
      ...(readbackVerified ? {} : {
        error: {
          code: 'CROSS_BORDER_CHARGE_READBACK_FAILED',
          message: '跨境巴士实际扣费已写入，但本地回读校验失败，不能标记为完成。',
        },
      }),
      savedOrderCount: preview.rows.length,
      exactCount: preview.rows.filter((row) => row.matchStatus === 'exact').length,
      exactOrderCount: preview.exactOrderGroups.length,
      unmatchedCount: preview.rows.filter((row) => row.matchStatus === 'unmatched').length,
      ambiguousCount: preview.rows.filter((row) => row.matchStatus === 'ambiguous').length,
      rows: readback.rows,
      committedAt: timestamp,
    };
  }

  function listLinks(query = {}, requestContext = {}) {
    return chargeRepository.listChargeLinks(query, { ...requestContext, profileId });
  }

  function listRecords(query = {}, requestContext = {}) {
    return chargeRepository.listChargeRecords(query, { ...requestContext, profileId });
  }

  function revalueStoredCharges(requestContext = {}, options = {}) {
    const context = chargeRepository.normalizeScope({ ...requestContext, profileId });
    const policy = readRechargePolicy();
    const compactPolicy = compactCrossBorderRechargePolicy(policy);
    const records = chargeRepository.listChargeRecords({ limit: MAX_SOURCE_ROWS }, context).rows;
    const links = chargeRepository.listChargeLinks({ limit: MAX_SOURCE_ORDERS }, context).rows;
    const recordsByCollection = groupCharges(records.map((record) => ({
      ...record,
      collectionNumber: record.collectionNumber,
    })));
    const timestamp = new Date(now()).toISOString();
    const recalculatedRows = links.map((link) => {
      const statements = recordsByCollection.get(link.collectionNumber) || [];
      const ledger = summarizeCrossBorderLedger(statements, ledgerOptions(policy));
      const evidence = link.evidence && typeof link.evidence === 'object' ? link.evidence : {};
      const sourceHash = createStableHash({
        browserAccountRef: link.browserAccountRef,
        crossBorderAccountId: link.crossBorderAccountId,
        externalAccountRef: link.externalAccountRef,
        collectionNumber: link.collectionNumber,
        postingNumber: link.postingNumber,
        statementHashes: statements.map((statement) => statement.sourceRecordHash),
        ledgerNetCny: ledger.ledgerNetCny,
        cashNetCny: ledger.cashNetCny,
        actualFeeCny: ledger.actualFeeCny,
        conversionPolicy: compactPolicy,
        matchStatus: link.matchStatus,
        shopId: link.shopId,
      }, { length: 40 });
      return {
        ...link,
        internalOrderId: evidence.internalOrderId || '',
        statements,
        ...ledger,
        conversionPolicy: compactPolicy,
        conversions: ledger.conversions,
        sourceHash,
        evidence: {
          ...evidence,
          source: 'cross-border-bus-ledger-cash-converted',
          sourceHash,
          statementCount: ledger.statementCount,
          expenseCny: ledger.expenseCny,
          incomeCny: ledger.incomeCny,
          ledgerNetCny: ledger.ledgerNetCny,
          balanceNetCny: ledger.ledgerNetCny,
          cashExpenseCny: ledger.cashExpenseCny,
          cashIncomeCny: ledger.cashIncomeCny,
          cashNetCny: ledger.cashNetCny,
          actualFeeCny: ledger.actualFeeCny,
          conversionPolicy: compactPolicy,
          conversions: ledger.conversions,
          revaluedAt: timestamp,
        },
        lastSeenAt: link.lastSeenAt || timestamp,
      };
    });
    const exactOrderGroups = buildExactOrderGroups(recalculatedRows);
    exactOrderGroups.forEach((group) => {
      group.conversionPolicy = compactPolicy;
    });
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      chargeRepository.upsertChargeLinks(recalculatedRows, context);
      recalculatedRows.filter((row) => row.matchStatus === 'exact')
        .forEach((row) => persistExactCollectionProjection(row, timestamp));
      exactOrderGroups.forEach((group) => persistExactOrderProjection(group, timestamp));
      if (manageTransaction) db.exec('COMMIT');
    } catch (error) {
      if (manageTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      statementCount: records.length,
      collectionCount: recalculatedRows.length,
      exactOrderCount: exactOrderGroups.length,
      balanceNetCny: Math.round(recalculatedRows.reduce((sum, row) => sum + row.ledgerNetCny, 0) * 100) / 100,
      cashNetCny: Math.round(recalculatedRows.reduce((sum, row) => sum + row.cashNetCny, 0) * 100) / 100,
      actualFeeCny: Math.round(exactOrderGroups.reduce((sum, row) => sum + row.actualFeeCny, 0) * 100) / 100,
      conversionPolicy: compactPolicy,
      revaluedAt: timestamp,
    };
  }

  return {
    domain: 'cross-border-charges',
    buildPreview,
    confirmImport,
    listLinks,
    listRecords,
    revalueStoredCharges,
  };
}
