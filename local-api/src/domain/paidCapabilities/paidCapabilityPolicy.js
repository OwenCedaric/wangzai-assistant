const CAPABILITY_LIST = [
  'text.product-description',
  'text.image-plan',
  'text.data-analysis',
  'text.external-insight',
  'image.generate',
  'image.edit',
  'external.seerfar.shop',
  'external.seerfar.product-detail',
  'external.seerfar.category',
  'external.seerfar.product-report',
  'external.seerfar.market-keyword',
  'external.seerfar.keyword-mining',
  'external.seerfar.keyword-back',
];

export const PAID_CAPABILITY_IDS = Object.freeze([...CAPABILITY_LIST]);

const CAPABILITIES = new Set(PAID_CAPABILITY_IDS);
const REQUEST_FIELDS = Object.freeze([
  'byok',
  'capability',
  'fallbackPolicy',
  'idempotencyKey',
  'input',
  'version',
]);
const BYOK_FIELDS = Object.freeze(['accountId', 'model']);
const FALLBACK_POLICIES = new Set([
  'points-if-byok-unavailable',
  'never',
  'ask',
]);
const BYOK_FAILURE_STATUSES = new Set(['auth-failed', 'limited', 'error']);
const BYOK_HEALTH_TTL_MS = 10 * 60 * 1000;
const MAX_INPUT_NODES = 20_000;

export class PaidCapabilityPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaidCapabilityPolicyError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PaidCapabilityPolicyError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactFields(value, expected, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain object.`);
  let keys;
  try {
    keys = Object.keys(value).sort();
  } catch {
    fail(code, `${label} is unreadable.`);
  }
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${label} fields do not match the public contract.`, {
      actualFields: keys,
      expectedFields: expected,
    });
  }
}

function readField(value, key, code, label) {
  try {
    return value[key];
  } catch {
    fail(code, `${label}.${key} is unreadable.`);
  }
}

function boundedCloneAndFreeze(value) {
  let cloned;
  try {
    cloned = structuredClone(value);
  } catch {
    fail('PAID_CAPABILITY_INPUT_INVALID', 'Paid capability input must be structured-cloneable.');
  }
  const pending = [cloned];
  const seen = new Set();
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) {
      fail('PAID_CAPABILITY_INPUT_INVALID', 'Paid capability input cannot contain cycles.');
    }
    seen.add(current);
    visited += 1;
    if (visited > MAX_INPUT_NODES) {
      fail('PAID_CAPABILITY_INPUT_LIMIT_EXCEEDED', 'Paid capability input is too large.');
    }
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
  return cloned;
}

export function validatePaidCapabilityIdempotencyKey(value) {
  if (
    typeof value !== 'string'
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    fail(
      'PAID_CAPABILITY_IDEMPOTENCY_INVALID',
      'Paid capability idempotency key is invalid.',
    );
  }
  return value;
}

export function isVerifiedModelApiAccount(account) {
  if (
    !account
    || account.discoveryVerified !== true
    || typeof account.apiKey !== 'string'
    || !account.apiKey.trim()
  ) return false;
  try {
    const url = new URL(String(account.baseUrl || ''));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function normalizeByok(value) {
  exactFields(value, BYOK_FIELDS, 'PAID_CAPABILITY_BYOK_INVALID', 'Paid capability BYOK selection');
  const accountId = readField(value, 'accountId', 'PAID_CAPABILITY_BYOK_INVALID', 'byok');
  const model = readField(value, 'model', 'PAID_CAPABILITY_BYOK_INVALID', 'byok');
  if (
    typeof accountId !== 'string'
    || accountId.length > 160
    || /[\r\n]/u.test(accountId)
    || typeof model !== 'string'
    || model.length > 160
    || /[\r\n]/u.test(model)
  ) {
    fail('PAID_CAPABILITY_BYOK_INVALID', 'Paid capability BYOK selection is invalid.');
  }
  return Object.freeze({ accountId, model });
}

export function createPaidCapabilityRequest(value) {
  exactFields(
    value,
    REQUEST_FIELDS,
    'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    'Paid capability request',
  );
  const capability = readField(
    value,
    'capability',
    'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    'request',
  );
  const version = readField(
    value,
    'version',
    'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    'request',
  );
  if (typeof capability !== 'string' || !CAPABILITIES.has(capability) || version !== 1) {
    fail('PAID_CAPABILITY_UNSUPPORTED', 'Paid capability/version is unsupported.', {
      capability,
      version,
    });
  }
  const fallbackPolicy = readField(
    value,
    'fallbackPolicy',
    'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    'request',
  );
  if (typeof fallbackPolicy !== 'string' || !FALLBACK_POLICIES.has(fallbackPolicy)) {
    fail('PAID_CAPABILITY_FALLBACK_POLICY_INVALID', 'Paid capability fallback policy is invalid.');
  }
  const input = readField(
    value,
    'input',
    'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
    'request',
  );
  if (!isPlainObject(input)) {
    fail('PAID_CAPABILITY_INPUT_INVALID', 'Paid capability input must be a plain object.');
  }
  return Object.freeze({
    capability,
    version,
    byok: normalizeByok(readField(
      value,
      'byok',
      'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
      'request',
    )),
    input: boundedCloneAndFreeze(input),
    fallbackPolicy,
    idempotencyKey: validatePaidCapabilityIdempotencyKey(readField(
      value,
      'idempotencyKey',
      'PAID_CAPABILITY_REQUEST_FIELDS_INVALID',
      'request',
    )),
  });
}

function result(request, route, code, requiresServerAuthorization) {
  return Object.freeze({
    capability: request.capability,
    version: request.version,
    route,
    code,
    requiresServerAuthorization,
  });
}

function paidFallback(request, cloud) {
  if (request.fallbackPolicy !== 'points-if-byok-unavailable') {
    return result(request, 'blocked', 'PAID_CAPABILITY_FALLBACK_DISABLED', false);
  }
  if (!cloud?.configured || !cloud?.available) {
    return result(request, 'blocked', 'PAID_CAPABILITY_GATEWAY_UNAVAILABLE', false);
  }
  if (!cloud?.authenticated) {
    return result(request, 'blocked', 'PAID_CAPABILITY_AUTH_REQUIRED', false);
  }
  if (!cloud?.permissionGranted) {
    return result(request, 'blocked', 'PAID_CAPABILITY_FORBIDDEN', false);
  }
  return result(request, 'paid-cloud', null, true);
}

function testedAtIsFresh(value, now) {
  const testedAt = new Date(value);
  const current = now instanceof Date ? now : new Date(now);
  const testedTime = testedAt.getTime();
  const currentTime = current.getTime();
  if (!Number.isFinite(testedTime) || !Number.isFinite(currentTime)) return false;
  const age = currentTime - testedTime;
  return age >= 0 && age <= BYOK_HEALTH_TTL_MS;
}

export function decidePaidCapabilityRoute(value, { now = new Date(), byok = {}, cloud = {} } = {}) {
  const request = createPaidCapabilityRequest(value);
  const locallyUsable = byok?.configured === true
    && byok?.credentialPresent === true
    && byok?.baseUrlSafe === true
    && byok?.capabilitySupported === true
    && byok?.modelAvailable === true;
  if (!locallyUsable) return paidFallback(request, cloud);
  if (BYOK_FAILURE_STATUSES.has(byok?.testStatus)) return paidFallback(request, cloud);
  if (byok?.testStatus !== 'connected' || !testedAtIsFresh(byok?.testedAt, now)) {
    return result(request, 'byok-health-check', 'PAID_CAPABILITY_BYOK_HEALTH_REQUIRED', false);
  }
  return result(request, 'byok', null, false);
}

export const paidCapabilityPolicyContract = Object.freeze({
  byokHealthTtlMs: BYOK_HEALTH_TTL_MS,
  byokFields: BYOK_FIELDS,
  requestFields: REQUEST_FIELDS,
});
