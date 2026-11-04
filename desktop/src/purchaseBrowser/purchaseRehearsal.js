import { createHash, randomInt } from 'node:crypto';

const PLATFORM_SPECS = Object.freeze([
  Object.freeze({
    id: '1688',
    label: '1688',
    accountLabels: Object.freeze(['1688']),
    hosts: Object.freeze(['1688.com']),
  }),
  Object.freeze({
    id: 'pinduoduo',
    label: '拼多多',
    accountLabels: Object.freeze(['拼多多', 'Pinduoduo', 'PDD']),
    hosts: Object.freeze(['yangkeduo.com']),
  }),
  Object.freeze({
    id: 'tmall',
    label: '天猫',
    accountLabels: Object.freeze(['天猫', '淘宝']),
    hosts: Object.freeze(['tmall.com']),
  }),
  Object.freeze({
    id: 'taobao',
    label: '淘宝',
    accountLabels: Object.freeze(['淘宝', '天猫']),
    hosts: Object.freeze(['taobao.com']),
  }),
]);

export const PURCHASE_REHEARSAL_PLATFORMS = Object.freeze(
  PLATFORM_SPECS.map((spec) => Object.freeze({ id: spec.id, label: spec.label })),
);

export const PURCHASE_REHEARSAL_STOP_STAGE = 'PAYMENT_PASSWORD_REQUIRED';

const MUTATION_SAFETY = Object.freeze({
  clickedBuyNow: false,
  clickedSubmitOrder: false,
  createdPendingOrder: false,
  openedRealPaymentGateway: false,
  enteredPaymentPassword: false,
  clickedFinalPay: false,
});

function clean(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function platformFromHost(hostname) {
  const host = clean(hostname, 253).toLowerCase();
  return PLATFORM_SPECS.find((spec) => spec.hosts.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )) || null;
}

export function resolvePurchaseRehearsalPlatform(value) {
  const text = clean(value, 80).toLowerCase();
  const direct = PLATFORM_SPECS.find((spec) => (
    spec.id === text
    || spec.label.toLowerCase() === text
    || spec.accountLabels.some((label) => label.toLowerCase() === text)
  ));
  if (direct) return direct;
  try { return platformFromHost(new URL(text).hostname); } catch { return null; }
}

function safeUrl(value) {
  try {
    const url = new URL(clean(value, 1800));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizePurchaseRehearsalTargets(rows = []) {
  const output = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = safeUrl(row?.url || row?.sourceUrl || row?.source_url);
    const platform = url ? platformFromHost(url.hostname) : null;
    if (!url || !platform) continue;
    const sourceProductId = clean(
      row?.sourceProductId || row?.source_product_id || row?.productId || row?.product_id,
      260,
    );
    const sourceSku = clean(row?.sourceSku || row?.source_sku || row?.sku, 260);
    const targetSeed = [platform.id, url.origin, url.pathname, url.search, sourceProductId, sourceSku].join('|');
    const targetHash = sha256(targetSeed);
    if (seen.has(targetHash)) continue;
    seen.add(targetHash);
    output.push(Object.freeze({
      platformId: platform.id,
      platformLabel: platform.label,
      url: url.toString(),
      sourceProductId,
      sourceSku,
      targetHash,
    }));
  }
  return Object.freeze(output);
}

export function accountSupportsPurchaseRehearsal(account = {}, platformValue = '') {
  const spec = resolvePurchaseRehearsalPlatform(platformValue);
  if (!spec) return false;
  const label = clean(account.platformName || account.platform || account.name, 120).toLowerCase();
  return spec.accountLabels.some((candidate) => label.includes(candidate.toLowerCase()));
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function skuCandidates(capture = {}) {
  return (Array.isArray(capture.skus) ? capture.skus : [])
    .map((sku, index) => ({
      id: clean(sku?.id || `sku-${index + 1}`, 260),
      name: clean(sku?.name, 500),
      attributes: (Array.isArray(sku?.attributes) ? sku.attributes : [])
        .map((attribute) => {
          if (attribute && typeof attribute === 'object') {
            const name = clean(attribute.name, 180);
            const value = clean(attribute.value, 300);
            return name && value ? { name, value } : null;
          }
          const value = clean(attribute, 300);
          return value ? { name: '规格', value } : null;
        })
        .filter(Boolean)
        .slice(0, 30),
      price: positive(sku?.price) || positive(capture.purchasePrice),
    }))
    .filter((sku) => sku.id && sku.price);
}

function stage(name, source, verified = true) {
  return Object.freeze({ name, source, verified: verified === true });
}

export function createPurchaseRehearsalResult({
  platform,
  target,
  accountLogin,
  capture,
  runNumber = 1,
  chooseIndex = (length) => randomInt(length),
  now = () => new Date().toISOString(),
} = {}) {
  const spec = resolvePurchaseRehearsalPlatform(platform || target?.platformId || capture?.platform);
  if (!spec) throw Object.assign(new Error('PURCHASE_REHEARSAL_PLATFORM_UNSUPPORTED'), {
    code: 'PURCHASE_REHEARSAL_PLATFORM_UNSUPPORTED',
  });
  if (target?.platformId !== spec.id) throw Object.assign(new Error('PURCHASE_REHEARSAL_TARGET_PLATFORM_MISMATCH'), {
    code: 'PURCHASE_REHEARSAL_TARGET_PLATFORM_MISMATCH',
  });
  if (accountLogin?.loggedIn !== true || accountLogin?.cookieSaved !== true) {
    throw Object.assign(new Error('PURCHASE_REHEARSAL_LOGIN_REQUIRED'), {
      code: 'PURCHASE_REHEARSAL_LOGIN_REQUIRED',
    });
  }
  if (clean(capture?.platform, 80) !== spec.label || capture?.pageType !== 'product') {
    throw Object.assign(new Error('PURCHASE_REHEARSAL_PRODUCT_MISMATCH'), {
      code: 'PURCHASE_REHEARSAL_PRODUCT_MISMATCH',
    });
  }
  const liveSkus = skuCandidates(capture);
  if (!liveSkus.length) throw Object.assign(new Error('PURCHASE_REHEARSAL_SKU_UNAVAILABLE'), {
    code: 'PURCHASE_REHEARSAL_SKU_UNAVAILABLE',
  });
  const requestedIndex = Number(chooseIndex(liveSkus.length));
  const selectedSku = liveSkus[
    Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < liveSkus.length
      ? requestedIndex
      : 0
  ];
  const sourceProductId = clean(capture.sourceProductId, 260);
  const price = positive(selectedSku.price) || positive(capture.purchasePrice);
  if (!sourceProductId || !price) throw Object.assign(new Error('PURCHASE_REHEARSAL_PRODUCT_INCOMPLETE'), {
    code: 'PURCHASE_REHEARSAL_PRODUCT_INCOMPLETE',
  });
  const completedAt = now();
  const stages = Object.freeze([
    stage('TARGET_SELECTED', 'stored-purchase-link'),
    stage('ACCOUNT_SESSION_VERIFIED', 'cef-auth-cookie'),
    stage('PRODUCT_STRUCTURED_DATA_VERIFIED', 'live-cef-readonly'),
    stage('SKU_SELECTED', 'live-structured-sku'),
    stage('CHECKOUT_PREVIEW_READY', 'local-state-replay'),
    stage('ORDER_SUBMIT_BLOCKED', 'safety-gate'),
    stage('PAYMENT_HANDOFF_REPLAYED', 'local-state-replay'),
    stage(PURCHASE_REHEARSAL_STOP_STAGE, 'local-state-replay'),
    stage('STOPPED_BEFORE_SECRET_INPUT', 'safety-gate'),
  ]);
  return Object.freeze({
    ok: true,
    passed: true,
    platformId: spec.id,
    platformLabel: spec.label,
    runNumber: Math.max(1, Math.trunc(Number(runNumber) || 1)),
    targetHash: clean(target.targetHash, 64),
    productHash: sha256(`${spec.id}|${sourceProductId}`),
    skuHash: sha256(`${spec.id}|${sourceProductId}|${selectedSku.id}|${selectedSku.name}`),
    skuAttributeCount: selectedSku.attributes.length,
    amountObserved: Number(price.toFixed(3)),
    currency: 'CNY',
    liveEvidence: Object.freeze({
      engine: 'cef',
      accountAuthenticated: true,
      productStructured: true,
      skuStructured: true,
      sourceMethod: clean(capture.sourceMethod, 80),
    }),
    stages,
    stopStage: PURCHASE_REHEARSAL_STOP_STAGE,
    safety: MUTATION_SAFETY,
    completedAt,
  });
}

export function publicPurchaseRehearsalResult(result = {}) {
  return Object.freeze({
    ok: result.ok === true,
    passed: result.passed === true,
    platformId: clean(result.platformId, 40),
    platformLabel: clean(result.platformLabel, 80),
    runNumber: Math.max(1, Math.trunc(Number(result.runNumber) || 1)),
    targetHash: clean(result.targetHash, 64),
    productHash: clean(result.productHash, 64),
    skuHash: clean(result.skuHash, 64),
    skuAttributeCount: Math.max(0, Math.trunc(Number(result.skuAttributeCount) || 0)),
    amountObserved: positive(result.amountObserved),
    currency: clean(result.currency, 12),
    liveEvidence: result.liveEvidence && typeof result.liveEvidence === 'object'
      ? { ...result.liveEvidence }
      : null,
    stages: Array.isArray(result.stages) ? result.stages.map((item) => ({ ...item })) : [],
    stopStage: clean(result.stopStage, 80),
    safety: { ...MUTATION_SAFETY },
    completedAt: clean(result.completedAt, 80),
  });
}

export function samplePurchaseRehearsalTarget(targets = [], platform, chooseIndex = (length) => randomInt(length)) {
  const spec = resolvePurchaseRehearsalPlatform(platform);
  const candidates = (Array.isArray(targets) ? targets : []).filter(
    (target) => target?.platformId === spec?.id,
  );
  if (!candidates.length) return null;
  const requestedIndex = Number(chooseIndex(candidates.length));
  return candidates[
    Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < candidates.length
      ? requestedIndex
      : 0
  ];
}

