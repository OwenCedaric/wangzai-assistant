import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9._:@/+=-]{1,180}$/u;
const SHARED_ALIPAY_LOGIN_ACCOUNT_REF = 'shared:alipay-login';

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requiredRef(value, code = 'PURCHASE_PAYMENT_ACCOUNT_REF_REQUIRED') {
  const ref = String(value || '').trim();
  if (!ACCOUNT_REF_PATTERN.test(ref)) fail(code);
  return ref;
}

function optionalText(value, max = 260) {
  return String(value || '').trim().slice(0, max);
}

function normalizeRecord(value = {}) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    accountRef: requiredRef(record.accountRef),
    platform: optionalText(record.platform, 40),
    loginAccount: optionalText(record.loginAccount, 260),
    loginPassword: optionalText(record.loginPassword, 128),
    paymentPassword: optionalText(record.paymentPassword, 128),
    updatedAt: optionalText(record.updatedAt, 80),
  };
}

function normalizeDocument(value = {}) {
  const document = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const records = document.records && typeof document.records === 'object' && !Array.isArray(document.records)
    ? document.records
    : {};
  const next = {};
  for (const [accountRef, valueRecord] of Object.entries(records)) {
    if (!ACCOUNT_REF_PATTERN.test(accountRef)) continue;
    try {
      const normalized = normalizeRecord({ ...valueRecord, accountRef });
      if (
        normalized.paymentPassword
        || normalized.loginPassword
        || (accountRef === SHARED_ALIPAY_LOGIN_ACCOUNT_REF && normalized.loginAccount)
      ) next[accountRef] = normalized;
    } catch {
      // Ignore damaged individual records and keep the rest recoverable.
    }
  }
  return { version: STORE_VERSION, records: next };
}

export function createPurchasePaymentCredentialStore({ filePath, protector } = {}) {
  const resolvedPath = path.resolve(String(filePath || '').trim());
  if (!resolvedPath || !protector?.protect || !protector?.unprotect) {
    fail('PURCHASE_PAYMENT_CREDENTIAL_STORE_DEPENDENCY_REQUIRED');
  }
  const backupPath = `${resolvedPath}.bak`;
  let document = null;

  function readFile(candidate) {
    if (!fs.existsSync(candidate)) return null;
    const envelope = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (envelope?.version !== STORE_VERSION || typeof envelope.ciphertext !== 'string') {
      fail('PURCHASE_PAYMENT_CREDENTIAL_STORE_INVALID');
    }
    return normalizeDocument(JSON.parse(protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'))));
  }

  function load() {
    if (document) return document;
    try {
      document = readFile(resolvedPath) || readFile(backupPath) || { version: STORE_VERSION, records: {} };
    } catch (error) {
      if (error?.code?.startsWith?.('PURCHASE_PAYMENT_')) throw error;
      document = readFile(backupPath) || { version: STORE_VERSION, records: {} };
    }
    return document;
  }

  function persist() {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const ciphertext = protector.protect(JSON.stringify(document)).toString('base64');
    const envelope = JSON.stringify({ version: STORE_VERSION, ciphertext });
    const temporaryPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${envelope}\n`, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(resolvedPath)) fs.copyFileSync(resolvedPath, backupPath);
    fs.renameSync(temporaryPath, resolvedPath);
    // Keep recovery usable without retaining a previous password after an
    // update or explicit clear.  The backup mirrors the newly committed
    // encrypted document instead of becoming a recoverable stale secret.
    fs.copyFileSync(resolvedPath, backupPath);
  }

  function save({ accountRef, platform, loginAccount, paymentPassword } = {}) {
    const normalized = normalizeRecord({ accountRef, platform, loginAccount, paymentPassword, updatedAt: new Date().toISOString() });
    if (!normalized.paymentPassword) fail('PURCHASE_PAYMENT_PASSWORD_REQUIRED');
    load().records[normalized.accountRef] = normalized;
    persist();
    return {
      ok: true,
      accountRef: normalized.accountRef,
      platform: normalized.platform,
      loginAccount: normalized.loginAccount,
      updatedAt: normalized.updatedAt,
    };
  }

  function get(accountRef) {
    const normalizedRef = requiredRef(accountRef);
    const record = load().records[normalizedRef];
    return record ? { ...record } : null;
  }

  function saveAlipayLogin({ loginAccount, loginPassword } = {}) {
    const normalized = normalizeRecord({
      accountRef: SHARED_ALIPAY_LOGIN_ACCOUNT_REF,
      platform: '支付宝',
      loginAccount,
      loginPassword,
      paymentPassword: '',
      updatedAt: new Date().toISOString(),
    });
    if (!normalized.loginAccount) fail('ALIPAY_LOGIN_ACCOUNT_REQUIRED');
    load().records[SHARED_ALIPAY_LOGIN_ACCOUNT_REF] = normalized;
    persist();
    return {
      ok: true,
      accountRef: SHARED_ALIPAY_LOGIN_ACCOUNT_REF,
      loginAccount: normalized.loginAccount,
      updatedAt: normalized.updatedAt,
    };
  }

  function getAlipayLogin() {
    const record = load().records[SHARED_ALIPAY_LOGIN_ACCOUNT_REF];
    return record?.loginAccount ? { ...record } : null;
  }

  function clearAlipayLogin() {
    delete load().records[SHARED_ALIPAY_LOGIN_ACCOUNT_REF];
    persist();
    return { ok: true, accountRef: SHARED_ALIPAY_LOGIN_ACCOUNT_REF };
  }

  function alipayLoginStatus() {
    const record = load().records[SHARED_ALIPAY_LOGIN_ACCOUNT_REF];
    return {
      ok: true,
      accountRef: SHARED_ALIPAY_LOGIN_ACCOUNT_REF,
      configured: Boolean(record?.loginAccount),
      passwordConfigured: Boolean(record?.loginPassword),
      loginAccount: record?.loginAccount || '',
      updatedAt: record?.updatedAt || '',
    };
  }

  function clear(accountRef) {
    const normalizedRef = requiredRef(accountRef);
    delete load().records[normalizedRef];
    persist();
    return { ok: true, accountRef: normalizedRef };
  }

  function status(accountRef) {
    const normalizedRef = requiredRef(accountRef);
    const record = load().records[normalizedRef];
    return {
      ok: true,
      accountRef: normalizedRef,
      configured: Boolean(record?.paymentPassword),
      platform: record?.platform || '',
      loginAccount: record?.loginAccount || '',
      updatedAt: record?.updatedAt || '',
    };
  }

  return Object.freeze({
    clear,
    get,
    save,
    status,
    saveAlipayLogin,
    getAlipayLogin,
    clearAlipayLogin,
    alipayLoginStatus,
  });
}
