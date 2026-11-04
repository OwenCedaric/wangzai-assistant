import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createPurchaseOrderOverrideRepository } from '../../db/repositories/purchaseOrderOverrideRepository.js';
import { createPurchaseSourceLinkRepository } from '../../db/repositories/purchaseSourceLinkRepository.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PURCHASE_PLATFORMS = new Set(['1688', '淘宝', '天猫', '拼多多', 'Ozon买家', 'unknown']);
const PURCHASE_PAGE_TYPES = new Set(['product', 'order-list', 'order-detail', 'logistics-detail', 'unknown']);

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clean(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function required(value, code, maximum = 260) {
  const text = clean(value, maximum);
  if (!text) fail(code);
  return text;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const match = clean(value, 80).replace(/,/gu, '').match(/-?\d+(?:\.\d+)?/u);
  const number = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function safeUrl(value) {
  try {
    const url = new URL(required(value, 'PURCHASE_BROWSER_CAPTURE_URL_INVALID', 1800));
    const host = url.hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if ((!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) || url.username || url.password) {
      fail('PURCHASE_BROWSER_CAPTURE_URL_INVALID');
    }
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch (error) {
    if (error?.code) throw error;
    fail('PURCHASE_BROWSER_CAPTURE_URL_INVALID');
  }
}

function optionalSafeUrl(value) {
  const text = clean(value, 1800);
  return text ? safeUrl(text) : '';
}

function normalizePlatform(value) {
  const text = clean(value, 80);
  return PURCHASE_PLATFORMS.has(text) ? text : 'unknown';
}

function normalizePageType(value) {
  const text = clean(value, 80);
  return PURCHASE_PAGE_TYPES.has(text) ? text : 'unknown';
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = clean(value, 32);
  return text || null;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalTarget(value = {}) {
  return Object.freeze({
    targetId: required(value.targetId, 'PURCHASE_BROWSER_TARGET_REQUIRED', 180),
    shopId: required(value.shopId, 'PURCHASE_BROWSER_TARGET_REQUIRED', 180),
    orderKey: required(value.orderKey, 'PURCHASE_BROWSER_TARGET_REQUIRED', 260),
    ozonOrderId: clean(value.ozonOrderId, 260),
    sku: clean(value.sku, 260),
    offerId: clean(value.offerId, 260),
    productTitle: clean(value.productTitle, 600),
    quantity: typeof value.quantity === 'number'
      ? (Number.isFinite(value.quantity) ? value.quantity : null)
      : clean(value.quantity, 32) || null,
    purchaseRecordId: clean(value.purchaseRecordId, 260),
    requiredFields: Object.freeze(
      (Array.isArray(value.requiredFields) ? value.requiredFields : [
        'purchasePlatform',
        'purchaseOrderNumber',
        'sourceCostCny',
        'sourceUrl',
      ])
        .map((field) => clean(field, 80))
        .filter(Boolean)
        .slice(0, 20),
    ),
    selectedAt: clean(value.selectedAt, 80),
  });
}

// GET readback intentionally uses a stable business identity rather than the
// full target fingerprint.  The browser query omits optional UI fields such as
// selectedAt/requiredFields, while targetId + shopId + orderKey still identify
// the only writable purchase scope.
function targetIdentityKey(target = {}) {
  return JSON.stringify([
    clean(target.targetId, 180),
    clean(target.shopId, 180),
    clean(target.orderKey, 260),
    clean(target.sku, 260),
    clean(target.offerId, 260),
    clean(target.purchaseRecordId, 260),
  ]);
}

function canonicalCapture(value = {}) {
  const purchasePrice = nonNegativeNumber(value.purchasePrice ?? value.amount);
  const currency = clean(value.currency, 12).toUpperCase() || 'CNY';
  const explicitSourceCostCny = nonNegativeNumber(value.sourceCostCny ?? value.purchasePriceCny);
  const pageUrl = optionalSafeUrl(value.pageUrl || value.sourceUrl);
  return Object.freeze({
    platform: normalizePlatform(value.platform),
    pageType: normalizePageType(value.pageType),
    pageUrl,
    pageTitle: clean(value.pageTitle || value.title, 300),
    sourceUrl: optionalSafeUrl(value.sourceUrl || value.pageUrl),
    purchaseOrderUrl: optionalSafeUrl(value.purchaseOrderUrl || value.orderUrl || value.pageUrl || value.sourceUrl),
    productTitle: clean(value.productTitle, 600),
    variant: clean(value.variant, 260),
    quantity: normalizeQuantity(value.quantity),
    purchaseOrderNumber: clean(value.purchaseOrderNumber || value.orderNumber, 260),
    purchaseOrderStatus: clean(
      value.purchaseOrderStatus || value.orderStatus || value.statusText || value.purchaseStatus,
      160,
    ),
    purchasePrice,
    currency,
    sourceCostCny: explicitSourceCostCny ?? (currency === 'CNY' ? purchasePrice : null),
    sourceProductId: clean(value.sourceProductId, 260),
    trackingNumber: clean(value.trackingNumber, 260),
    carrierName: clean(value.carrierName, 120),
    logisticsStatus: clean(value.logisticsStatus || value.status, 160),
    sourceConfidence: normalizeConfidence(value.sourceConfidence),
    fieldConfidence: Object.freeze({
      platform: normalizeConfidence(value.fieldConfidence?.platform),
      productTitle: normalizeConfidence(value.fieldConfidence?.productTitle),
      variant: normalizeConfidence(value.fieldConfidence?.variant),
      quantity: normalizeConfidence(value.fieldConfidence?.quantity),
      purchaseOrderNumber: normalizeConfidence(value.fieldConfidence?.purchaseOrderNumber),
      purchasePrice: normalizeConfidence(value.fieldConfidence?.purchasePrice),
      trackingNumber: normalizeConfidence(value.fieldConfidence?.trackingNumber),
    }),
    capturedAt: clean(value.capturedAt, 80),
    fixture: value.fixture === true,
  });
}

function isConfirmedRefundStatus(value = '') {
  const text = clean(value, 160);
  return Boolean(
    text
    && /极速退款成功|退款成功|已退款|退款完成/u.test(text)
    && !/申请退款|退款处理中|等待退款|退款审核|退款失败|退款关闭/u.test(text)
  );
}

function canonicalRefundCapture(value = {}) {
  return Object.freeze({
    platform: normalizePlatform(value.platform),
    purchaseOrderNumber: clean(value.purchaseOrderNumber || value.orderNumber, 260),
    purchaseOrderStatus: clean(
      value.purchaseOrderStatus || value.orderStatus || value.statusText || value.purchaseStatus,
      160,
    ),
    purchaseOrderUrl: optionalSafeUrl(value.purchaseOrderUrl || value.orderUrl || value.pageUrl || value.sourceUrl),
    capturedAt: clean(value.capturedAt, 80),
  });
}

function missingCaptureFields(capture) {
  return [
    ['purchasePlatform', capture.platform && capture.platform !== 'unknown' ? capture.platform : ''],
    ['purchaseOrderNumber', capture.purchaseOrderNumber],
    ['sourceCostCny', Number.isFinite(capture.sourceCostCny) && capture.sourceCostCny >= 0 ? capture.sourceCostCny : null],
    ['sourceUrl', capture.sourceUrl],
  ].filter(([, value]) => value === '' || value === null || value === undefined)
    .map(([field]) => field);
}

function sameToken(expectedHash, supplied) {
  if (!expectedHash || !supplied) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(sha256(supplied), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function pickComparableOverride(value = {}) {
  return {
    purchasePlatform: clean(value.purchasePlatform, 80),
    purchaseOrderNumber: clean(value.purchaseOrderNumber, 260),
    purchaseOrderUrl: clean(value.purchaseOrderUrl, 1800),
    sourceCostCny: finiteNumber(value.sourceCostCny),
    purchaseOrderStatus: clean(
      value.purchaseOrderStatus || value.manualPurchaseOrderStatus || value.manualStatus || value.status,
      160,
    ),
  };
}

function pickComparableLink(value = {}) {
  return {
    platform: clean(value.platform, 80),
    url: clean(value.url, 1800),
    sourceProductId: clean(value.sourceProductId, 260),
    title: clean(value.title, 600),
    priceValue: finiteNumber(value.priceValue),
    currencyCode: clean(value.currencyCode, 12),
    qty: clean(value.qty, 80),
  };
}

export function createPurchaseBrowserCaptureService(db, {
  now = () => Date.now(),
  createPreviewId = () => `purchase_capture_${randomUUID()}`,
  createConfirmationToken = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (!db?.prepare) fail('PURCHASE_BROWSER_CAPTURE_STORAGE_REQUIRED');
  const overrides = createPurchaseOrderOverrideRepository(db);
  const links = createPurchaseSourceLinkRepository(db);
  const previews = new Map();
  const completed = new Map();
  const completedByIdempotency = new Map();
  const completedByTarget = new Map();
  const refundPreviews = new Map();
  const refundCompleted = new Map();

  function captureWithCurrencyConversion(value = {}) {
    const capture = canonicalCapture(value);
    if (capture.sourceCostCny !== null || !['RUB', 'RUR'].includes(capture.currency) || capture.purchasePrice === null) {
      return capture;
    }
    const row = db.prepare(`
      SELECT rub_to_cny_rate, requested_date
      FROM exchange_rate_cache
      WHERE rub_to_cny_rate > 0
      ORDER BY requested_date DESC, updated_at DESC
      LIMIT 1
    `).get();
    const rate = nonNegativeNumber(row?.rub_to_cny_rate);
    if (rate === null || rate <= 0) return capture;
    return Object.freeze({
      ...capture,
      sourceCostCny: Number((capture.purchasePrice * rate).toFixed(2)),
      rubToCnyRate: rate,
      exchangeRateDate: clean(row?.requested_date, 10),
    });
  }

  function current(target) {
    const override = overrides.getOverride(target) || null;
    const sourceRows = links.listLinks({ ...target, pageSize: 100 }).rows || [];
    return { override, sourceLinks: sourceRows };
  }

  function sourceProductKey(target) {
    return clean(target.sku || target.offerId, 260);
  }

  function resolveSourceSlot(target, sourceRows = []) {
    const key = sourceProductKey(target);
    if (!key && sourceRows.length > 1) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    const matching = key
      ? sourceRows.filter((row) => clean(row.productKey || row.offerId || row.sku, 260) === key)
      : [];
    if (matching.length > 1) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    if (matching.length === 1) return Number(matching[0].slotIndex) || 0;
    const used = new Set(sourceRows.map((row) => Number(row.slotIndex)).filter(Number.isInteger));
    for (let slot = 0; slot < 20; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
  }

  function intended(target, capture, sourceRows = [], currentOverride = {}) {
    const sourceSlotIndex = resolveSourceSlot(target, sourceRows);
    return {
      override: {
        ...target,
        purchasePlatform: capture.platform,
        purchaseOrderNumber: capture.purchaseOrderNumber,
        purchaseOrderUrl: capture.purchaseOrderUrl || capture.sourceUrl,
        sourceCostCny: capture.sourceCostCny,
        purchaseOrderStatus: capture.purchaseOrderStatus
          || clean(currentOverride.manualStatus || currentOverride.purchaseOrderStatus, 160),
      },
      sourceLink: {
        ...target,
        productKey: target.sku || target.offerId,
        slotIndex: sourceSlotIndex,
        isPrimary: true,
        platform: capture.platform,
        url: capture.sourceUrl,
        sourceProductId: capture.sourceProductId,
        title: capture.productTitle,
        priceValue: capture.purchasePrice,
        currencyCode: capture.currency,
        qty: String(capture.quantity ?? target.quantity ?? ''),
      },
      sourceSlotIndex,
    };
  }

  function preview(input = {}) {
    const target = canonicalTarget(input.target);
    const capture = captureWithCurrencyConversion(input.capture);
    const before = current(target);
    const after = intended(target, capture, before.sourceLinks, before.override || {});
    const missingFields = missingCaptureFields(capture);
    const conflicts = [];
    const beforeOverride = pickComparableOverride(before.override || {});
    const afterOverride = pickComparableOverride(after.override);
    for (const [field, nextValue] of Object.entries(afterOverride)) {
      const currentValue = beforeOverride[field];
      if (currentValue !== '' && currentValue !== null && currentValue !== nextValue) conflicts.push(field);
    }
    const previewId = createPreviewId();
    const confirmationToken = createConfirmationToken();
    const idempotencyKey = clean(input.idempotencyKey || previewId, 180);
    if (!idempotencyKey) fail('PURCHASE_BROWSER_IDEMPOTENCY_KEY_REQUIRED');
    const captureHash = sha256(JSON.stringify(capture));
    const targetHash = sha256(JSON.stringify(target));
    const expiresAtMs = now() + PREVIEW_TTL_MS;
    previews.set(previewId, {
      previewId,
      target,
      capture,
      after,
      missingFields,
      conflicts,
      confirmationTokenHash: sha256(confirmationToken),
      captureHash,
      targetHash,
      sourceSlotIndex: after.sourceSlotIndex,
      idempotencyKey,
      expiresAtMs,
    });
    return {
      ok: true,
      previewId,
      confirmationToken,
      idempotencyKey,
      captureHash,
      target,
      before,
      after,
      changes: {
        override: afterOverride,
        sourceLink: pickComparableLink(after.sourceLink),
      },
      missingFields,
      conflicts,
      expiresAt: new Date(expiresAtMs).toISOString(),
      readbackRequired: true,
    };
  }

  function verifyReadback(record, readback) {
    const expectedOverride = pickComparableOverride(record.after.override);
    const actualOverride = pickComparableOverride(readback.override || {});
    const actualLink = (readback.sourceLinks || []).find((row) => Number(row.slotIndex) === Number(record.sourceSlotIndex)) || {};
    const expectedLink = pickComparableLink(record.after.sourceLink);
    return JSON.stringify(actualOverride) === JSON.stringify(expectedOverride)
      && JSON.stringify(pickComparableLink(actualLink)) === JSON.stringify(expectedLink);
  }

  function replayCompleted(record) {
    const readback = current(record.expected.target);
    if (!verifyReadback(record.expected, readback)) fail('PURCHASE_BROWSER_READBACK_FAILED');
    return record.result;
  }

  function confirm(input = {}) {
    const previewId = required(input.previewId, 'PURCHASE_BROWSER_CONFIRMATION_REQUIRED', 180);
    const suppliedIdempotencyKey = clean(input.idempotencyKey || previewId, 180);
    if (!suppliedIdempotencyKey) fail('PURCHASE_BROWSER_IDEMPOTENCY_KEY_REQUIRED');
    const completedByKey = completedByIdempotency.get(suppliedIdempotencyKey);
    if (completedByKey && completedByKey.previewId !== previewId) {
      const requestedTargetHash = sha256(JSON.stringify(canonicalTarget(input.target)));
      if (requestedTargetHash !== completedByKey.targetHash) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
      return replayCompleted(completedByKey);
    }
    if (completed.has(previewId)) {
      const completedRecord = completed.get(previewId);
      if (completedRecord.idempotencyKey !== suppliedIdempotencyKey) {
        fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
      }
      return replayCompleted(completedRecord);
    }
    const record = previews.get(previewId);
    if (!record || record.expiresAtMs < now()) {
      previews.delete(previewId);
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (record.idempotencyKey !== suppliedIdempotencyKey) fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    if (!sameToken(record.confirmationTokenHash, clean(input.confirmationToken, 300))) {
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (input.captureHash !== record.captureHash) fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    if (sha256(JSON.stringify(canonicalTarget(input.target))) !== record.targetHash) {
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    if (record.missingFields.length) fail('PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING');
    if (record.conflicts.length && input.acceptConflicts !== true) {
      fail('PURCHASE_BROWSER_CAPTURE_CONFLICT_CONFIRMATION_REQUIRED');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      links.saveLinks({
        ...record.target,
        primaryIndex: 0,
        links: [record.after.sourceLink],
      });
      overrides.upsertOverride(record.after.override);
      const readback = current(record.target);
      if (!verifyReadback(record, readback)) fail('PURCHASE_BROWSER_READBACK_FAILED');
      db.exec('COMMIT');
      const result = Object.freeze({
        ok: true,
        previewId,
        idempotencyKey: record.idempotencyKey,
        target: record.target,
        readback,
        readbackVerified: true,
      });
      previews.delete(previewId);
      const completedRecord = {
        previewId,
        idempotencyKey: record.idempotencyKey,
        targetHash: record.targetHash,
        targetKey: targetIdentityKey(record.target),
        expected: record,
        result,
      };
      completed.set(previewId, completedRecord);
      completedByIdempotency.set(record.idempotencyKey, completedRecord);
      completedByTarget.set(completedRecord.targetKey, completedRecord);
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function readback(input = {}) {
    const target = canonicalTarget(input.target || input);
    const readback = current(target);
    // A readback without a product key cannot safely choose one of several
    // source rows.  Keep the fail-closed rule consistent with preview().
    resolveSourceSlot(target, readback.sourceLinks);
    const completedRecord = completedByTarget.get(targetIdentityKey(target));
    const readbackVerified = Boolean(
      completedRecord && verifyReadback(completedRecord.expected, readback),
    );
    if (completedRecord && !readbackVerified) fail('PURCHASE_BROWSER_READBACK_FAILED');
    return {
      ok: true,
      target,
      ...readback,
      readbackVerified,
      ...(completedRecord ? { previewId: completedRecord.previewId } : {}),
    };
  }

  function previewRefund(input = {}) {
    const target = canonicalTarget(input.target);
    const capture = canonicalRefundCapture(input.capture);
    if (!capture.platform || capture.platform === 'unknown' || !PURCHASE_PLATFORMS.has(capture.platform)) {
      fail('PURCHASE_BROWSER_REFUND_PLATFORM_INVALID');
    }
    if (!capture.purchaseOrderNumber) fail('PURCHASE_BROWSER_REFUND_ORDER_NUMBER_REQUIRED');
    if (!isConfirmedRefundStatus(capture.purchaseOrderStatus)) {
      fail('PURCHASE_BROWSER_REFUND_NOT_CONFIRMED');
    }
    const before = current(target);
    if (!before.override) fail('PURCHASE_BROWSER_REFUND_PURCHASE_RECORD_MISSING');
    const currentOrderNumber = clean(before.override.purchaseOrderNumber, 260);
    const voidedOrderNumber = clean(before.override.voidedPurchaseOrderNo, 260);
    const currentPlatform = clean(
      before.override.purchasePlatform || before.override.voidedPurchasePlatform,
      80,
    );
    if (
      (currentOrderNumber && currentOrderNumber !== capture.purchaseOrderNumber)
      || (!currentOrderNumber && voidedOrderNumber !== capture.purchaseOrderNumber)
      || (currentPlatform && currentPlatform !== capture.platform)
    ) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    const targetProductKeys = new Set([target.sku, target.offerId].map((value) => clean(value, 260)).filter(Boolean));
    const storedProductKeys = [before.override.sku, before.override.offerId]
      .map((value) => clean(value, 260))
      .filter(Boolean);
    if (
      targetProductKeys.size
      && storedProductKeys.length
      && !storedProductKeys.some((value) => targetProductKeys.has(value))
    ) fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    const refundedAt = capture.capturedAt || new Date(now()).toISOString();
    const previousCost = finiteNumber(before.override.sourceCostCny);
    const previousPlatform = clean(before.override.purchasePlatform || before.override.voidedPurchasePlatform, 80)
      || capture.platform;
    const refundEvidence = Object.freeze({
      platform: capture.platform,
      purchaseOrderNumber: capture.purchaseOrderNumber,
      status: capture.purchaseOrderStatus,
      pageUrl: capture.purchaseOrderUrl,
      capturedAt: refundedAt,
    });
    const after = {
      override: {
        ...target,
        clearFields: [
          'purchasePlatform',
          'purchaseOrderNumber',
          'purchaseOrderUrl',
          'sourceCostCny',
          'manualStatus',
        ],
        raw: {
          ...before.override,
          forcePurchaseStatus: '待拍单',
          voidedPurchaseOrderNo: capture.purchaseOrderNumber,
          voidedPurchasePlatform: previousPlatform,
          ...(previousCost === null ? {} : { voidedPurchaseCostCny: previousCost }),
          purchaseRefundConfirmed: true,
          purchaseRefundStatus: capture.purchaseOrderStatus,
          purchaseRefundedAt: refundedAt,
          transferPendingAt: refundedAt,
          transferPendingReason: `${capture.platform}订单页已回读退款成功`,
          refundEvidence,
        },
      },
    };
    const previewId = createPreviewId();
    const confirmationToken = createConfirmationToken();
    const idempotencyKey = clean(input.idempotencyKey || previewId, 180);
    if (!idempotencyKey) fail('PURCHASE_BROWSER_IDEMPOTENCY_KEY_REQUIRED');
    const captureHash = sha256(JSON.stringify(capture));
    const targetHash = sha256(JSON.stringify(target));
    const expiresAtMs = now() + PREVIEW_TTL_MS;
    refundPreviews.set(previewId, {
      previewId,
      target,
      capture,
      before,
      after,
      confirmationTokenHash: sha256(confirmationToken),
      captureHash,
      targetHash,
      idempotencyKey,
      expiresAtMs,
    });
    return {
      ok: true,
      previewId,
      confirmationToken,
      idempotencyKey,
      captureHash,
      target,
      before,
      after,
      conflicts: [],
      missingFields: [],
      expiresAt: new Date(expiresAtMs).toISOString(),
      readbackRequired: true,
    };
  }

  function verifyRefundReadback(record, readback) {
    const override = readback.override || {};
    return clean(override.purchasePlatform, 80) === ''
      && clean(override.purchaseOrderNumber, 260) === ''
      && clean(override.purchaseOrderUrl, 1800) === ''
      && finiteNumber(override.sourceCostCny) === null
      && clean(override.manualStatus, 160) === ''
      && clean(override.forcePurchaseStatus, 80) === '待拍单'
      && clean(override.voidedPurchaseOrderNo, 260) === record.capture.purchaseOrderNumber
      && override.purchaseRefundConfirmed === true
      && isConfirmedRefundStatus(override.purchaseRefundStatus);
  }

  function confirmRefund(input = {}) {
    const previewId = required(input.previewId, 'PURCHASE_BROWSER_CONFIRMATION_REQUIRED', 180);
    const idempotencyKey = clean(input.idempotencyKey || previewId, 180);
    const completedRecord = refundCompleted.get(idempotencyKey);
    if (completedRecord) {
      if (completedRecord.previewId !== previewId) fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
      const readback = current(completedRecord.target);
      if (!verifyRefundReadback(completedRecord, readback)) fail('PURCHASE_BROWSER_READBACK_FAILED');
      return completedRecord.result;
    }
    const record = refundPreviews.get(previewId);
    if (!record || record.expiresAtMs < now()) {
      refundPreviews.delete(previewId);
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (record.idempotencyKey !== idempotencyKey) fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    if (!sameToken(record.confirmationTokenHash, clean(input.confirmationToken, 300))) {
      fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    }
    if (input.captureHash !== record.captureHash) fail('PURCHASE_BROWSER_CONFIRMATION_REQUIRED');
    if (sha256(JSON.stringify(canonicalTarget(input.target))) !== record.targetHash) {
      fail('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      overrides.upsertOverride(record.after.override);
      const readback = current(record.target);
      if (!verifyRefundReadback(record, readback)) fail('PURCHASE_BROWSER_READBACK_FAILED');
      db.exec('COMMIT');
      const result = Object.freeze({
        ok: true,
        previewId,
        idempotencyKey,
        target: record.target,
        readback,
        readbackVerified: true,
      });
      const saved = { ...record, result };
      refundPreviews.delete(previewId);
      refundCompleted.set(idempotencyKey, saved);
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return Object.freeze({ confirm, confirmRefund, preview, previewRefund, readback });
}
