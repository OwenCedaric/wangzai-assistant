import { LocalApiError, requestLocalApi } from '../api/localApiClient.js';
import { createProfitCoreBatch, decodeProfitWire, PRIVATE_PROFIT_VERSION, readProfitCoreResults } from './profitCoreWire.js';

const PROFITABILITY_FIELDS = Object.freeze([
  'acquiringBasisPoints',
  'commissionBasisPoints',
  'costMinor',
  'currency',
  'logisticsMinor',
  'salePriceMinor',
  'taxBasisPoints',
]);
const PROFITABILITY_RESULT_FIELDS = Object.freeze(['contributionMinor', 'currency', 'decision', 'marginBasisPoints']);
const COLLECTION_PRICING_FIELDS = Object.freeze([
  'commissionBasisPoints',
  'currency',
  'currentPriceMinor',
  'extraCostMinor',
  'firstMileCostMinor',
  'purchaseCostMinor',
  'targetMarginBasisPoints',
]);
const COLLECTION_PRICING_RESULT_FIELDS = Object.freeze([
  'breakEvenPriceMinor',
  'currency',
  'currentMarginBasisPoints',
  'currentProfitMinor',
  'suggestedPriceMinor',
  'totalCostMinor',
]);
const CONTRACT_LIST_FIELDS = Object.freeze(['capability', 'version']);
const SECRET_KEY =
  /(?:api[_-]?key|password|cookie|authorization|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|secret)/iu;

function fail(code, message, payload = null) {
  throw new LocalApiError(message, { status: 400, code, payload });
}

function exactFields(value, expected, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label}必须是对象。`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(code, `${label}字段不符合固定契约。`);
  }
}

function rejectSecretFields(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('PROTECTED_COMPUTE_INPUT_CYCLIC', '受保护计算输入不能包含循环引用。');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      fail('PROTECTED_COMPUTE_SECRET_REJECTED', '受保护计算输入不能包含账号密钥或令牌。');
    }
    rejectSecretFields(child, seen);
  }
}

function integer(value, field, { minimum = 0, maximum = 300_000_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('PROTECTED_COMPUTE_INPUT_INVALID', `${field}不符合整数范围。`);
  }
  return value;
}

function optionalPositiveInteger(value, field) {
  if (value === null) return null;
  return integer(value, field, { minimum: 1 });
}

function normalizeProfitabilityInput(input) {
  rejectSecretFields(input);
  exactFields(input, PROFITABILITY_FIELDS, 'PROTECTED_COMPUTE_INPUT_FIELDS_INVALID', '利润核价输入');
  const currency = String(input.currency || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    fail('PROTECTED_COMPUTE_INPUT_INVALID', 'currency 必须是三位币种代码。');
  }
  return {
    acquiringBasisPoints: integer(input.acquiringBasisPoints, 'acquiringBasisPoints', { maximum: 10_000 }),
    commissionBasisPoints: integer(input.commissionBasisPoints, 'commissionBasisPoints', { maximum: 10_000 }),
    costMinor: integer(input.costMinor, 'costMinor'),
    currency,
    logisticsMinor: integer(input.logisticsMinor, 'logisticsMinor'),
    salePriceMinor: integer(input.salePriceMinor, 'salePriceMinor', { minimum: 1 }),
    taxBasisPoints: integer(input.taxBasisPoints, 'taxBasisPoints', { maximum: 10_000 }),
  };
}

function normalizeCollectionPricingInput(input) {
  rejectSecretFields(input);
  exactFields(input, COLLECTION_PRICING_FIELDS, 'PROTECTED_COMPUTE_INPUT_FIELDS_INVALID', '采集核价输入');
  const currency = String(input.currency || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    fail('PROTECTED_COMPUTE_INPUT_INVALID', 'currency 必须是三位币种代码。');
  }
  return {
    commissionBasisPoints: integer(input.commissionBasisPoints, 'commissionBasisPoints', { maximum: 10_000 }),
    currency,
    currentPriceMinor: optionalPositiveInteger(input.currentPriceMinor, 'currentPriceMinor'),
    extraCostMinor: integer(input.extraCostMinor, 'extraCostMinor'),
    firstMileCostMinor: integer(input.firstMileCostMinor, 'firstMileCostMinor'),
    purchaseCostMinor: integer(input.purchaseCostMinor, 'purchaseCostMinor'),
    targetMarginBasisPoints: integer(input.targetMarginBasisPoints, 'targetMarginBasisPoints', {
      maximum: 1_000_000,
    }),
  };
}

function validateProfitabilityResult(result, payload) {
  if (
    !Number.isSafeInteger(result.contributionMinor) ||
    !Number.isSafeInteger(result.marginBasisPoints) ||
    !/^[A-Z]{3}$/u.test(result.currency || '') ||
    !['reject', 'review', 'acceptable', 'preferred'].includes(result.decision)
  ) {
    fail('PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID', '利润核价结果不符合固定契约。', payload);
  }
}

function validateCollectionPricingResult(result, payload) {
  if (
    !Number.isSafeInteger(result.breakEvenPriceMinor) ||
    result.breakEvenPriceMinor < 0 ||
    !Number.isSafeInteger(result.suggestedPriceMinor) ||
    result.suggestedPriceMinor < 0 ||
    !Number.isSafeInteger(result.totalCostMinor) ||
    result.totalCostMinor < 0 ||
    (result.currentMarginBasisPoints !== null && !Number.isSafeInteger(result.currentMarginBasisPoints)) ||
    (result.currentProfitMinor !== null && !Number.isSafeInteger(result.currentProfitMinor)) ||
    !/^[A-Z]{3}$/u.test(result.currency || '')
  ) {
    fail('PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID', '采集核价结果不符合固定契约。', payload);
  }
}

function normalizeContractItems(payload) {
  const seen = new Set();
  return payload.contracts.map((item) => {
    exactFields(item, CONTRACT_LIST_FIELDS, 'PROTECTED_COMPUTE_CONTRACTS_INVALID', '受保护计算契约');
    const capability = String(item.capability || '');
    const version = item.version;
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(capability) || !Number.isSafeInteger(version) || version < 1) {
      fail('PROTECTED_COMPUTE_CONTRACTS_INVALID', '受保护计算契约标识或版本无效。', payload);
    }
    const identity = `${capability}@${version}`;
    if (seen.has(identity)) {
      fail('PROTECTED_COMPUTE_CONTRACTS_INVALID', '受保护计算契约列表包含重复项。', payload);
    }
    seen.add(identity);
    return { capability, version };
  });
}

function normalizeVerifiedResult(payload, descriptor) {
  const { capability, version } = descriptor;
  if (
    !payload ||
    payload.ok !== true ||
    payload.contract !== 'local-protected-compute-result/v1' ||
    payload.capability !== capability ||
    payload.version !== version ||
    payload.signatureVerified !== true ||
    !['server-signed', 'offline-signed'].includes(payload.source)
  ) {
    fail('PROTECTED_COMPUTE_RESULT_UNVERIFIED', '受保护计算返回值未通过本地验签。', payload);
  }
  exactFields(
    payload.result,
    descriptor.resultFields,
    'PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID',
    descriptor.resultLabel
  );
  descriptor.validateResult(payload.result, payload);
  return {
    ...payload,
    result: { ...payload.result },
    verification: payload.verification && typeof payload.verification === 'object' ? { ...payload.verification } : {},
  };
}

function requireDesktopProtectedComputeProxy() {
  if (typeof globalThis.window?.wangzaiDesktop?.localApiRequest !== 'function') {
    fail('PROTECTED_COMPUTE_DESKTOP_PROXY_REQUIRED', '受保护计算只能通过桌面端主进程授权代理执行。');
  }
}

async function executeProtectedCapability(descriptor, input, options = {}) {
  requireDesktopProtectedComputeProxy();
  const payload = await requestLocalApi('/api/protected-compute/execute', {
    method: 'POST',
    body: {
      capability: descriptor.capability,
      version: descriptor.version,
      input: descriptor.normalizeInput(input),
    },
    timeoutMs: options.timeoutMs || 15_000,
    signal: options.signal,
  });
  return normalizeVerifiedResult(payload, descriptor);
}

const PROFITABILITY_DESCRIPTOR = Object.freeze({
  capability: 'profitability.quote',
  version: 1,
  inputFields: PROFITABILITY_FIELDS,
  resultFields: PROFITABILITY_RESULT_FIELDS,
  resultLabel: '利润核价结果',
  normalizeInput: normalizeProfitabilityInput,
  validateResult: validateProfitabilityResult,
});

const COLLECTION_PRICING_DESCRIPTOR = Object.freeze({
  capability: 'collection-pricing.quote',
  version: 1,
  inputFields: COLLECTION_PRICING_FIELDS,
  resultFields: COLLECTION_PRICING_RESULT_FIELDS,
  resultLabel: '采集核价结果',
  normalizeInput: normalizeCollectionPricingInput,
  validateResult: validateCollectionPricingResult,
});

export async function getProtectedComputeStatus(options = {}) {
  const payload = await requestLocalApi('/api/protected-compute/status', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (
    !payload ||
    payload.ok !== true ||
    payload.contract !== 'local-protected-compute-status/v1' ||
    typeof payload.available !== 'boolean' ||
    typeof payload.configured !== 'boolean' ||
    typeof payload.offlineEnabled !== 'boolean' ||
    (payload.available && !payload.configured) ||
    (payload.configVersion !== null && (!Number.isSafeInteger(payload.configVersion) || payload.configVersion < 1)) ||
    (payload.configExpiresAt !== null && (
      typeof payload.configExpiresAt !== 'string' ||
      !Number.isFinite(new Date(payload.configExpiresAt).getTime())
    )) ||
    (payload.reasonCode !== null && !/^PROTECTED_COMPUTE_[A-Z0-9_]+$/u.test(payload.reasonCode || '')) ||
    (payload.available && payload.reasonCode !== null) ||
    !Array.isArray(payload.contracts)
  ) {
    fail('PROTECTED_COMPUTE_STATUS_INVALID', '受保护计算状态返回值无效。', payload);
  }
  return { ...payload, contracts: normalizeContractItems(payload) };
}

export async function listProtectedComputeContracts(options = {}) {
  const payload = await requestLocalApi('/api/protected-compute/contracts', {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (
    !payload ||
    payload.ok !== true ||
    payload.contract !== 'local-protected-compute-contracts/v1' ||
    !Array.isArray(payload.contracts)
  ) {
    fail('PROTECTED_COMPUTE_CONTRACTS_INVALID', '受保护计算契约列表无效。', payload);
  }
  return normalizeContractItems(payload);
}

export async function executeProfitabilityQuote(input, options = {}) {
  return executeProtectedCapability(PROFITABILITY_DESCRIPTOR, input, options);
}

export async function executeCollectionPricingQuote(input, options = {}) {
  return executeProtectedCapability(COLLECTION_PRICING_DESCRIPTOR, input, options);
}

export async function executePrivateProfitCalls(calls, options = {}) {
  const descriptor = {
    capability: 'profit.ledger-batch', version: 1,
    inputFields: ['calculationVersion', 'callsJson'], resultFields: ['calculationVersion', 'resultsJson'],
    resultLabel: '服务器利润计算结果',
    normalizeInput: input => {
      if (input.calculationVersion !== PRIVATE_PROFIT_VERSION) throw new Error('PROFIT_CORE_VERSION_INVALID');
      return createProfitCoreBatch(decodeProfitWire(JSON.parse(input.callsJson)));
    },
    validateResult: result => { readProfitCoreResults(result, calls); },
  };
  const response = await executeProtectedCapability(descriptor, createProfitCoreBatch(calls), options);
  return readProfitCoreResults(response.result, calls);
}

export const protectedComputePublicContracts = Object.freeze({
  profitabilityQuote: Object.freeze({
    capability: PROFITABILITY_DESCRIPTOR.capability,
    version: PROFITABILITY_DESCRIPTOR.version,
    inputFields: PROFITABILITY_DESCRIPTOR.inputFields,
    resultFields: PROFITABILITY_DESCRIPTOR.resultFields,
  }),
  collectionPricingQuote: Object.freeze({
    capability: COLLECTION_PRICING_DESCRIPTOR.capability,
    version: COLLECTION_PRICING_DESCRIPTOR.version,
    inputFields: COLLECTION_PRICING_DESCRIPTOR.inputFields,
    resultFields: COLLECTION_PRICING_DESCRIPTOR.resultFields,
  }),
});
