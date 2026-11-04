const SECRET_KEY_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|companySecret)\b/gi;
const SECRET_PAIR_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|companySecret)\b(\s*[:=]\s*)(["'`]?)[^"'`,}\]\s]+(["'`]?)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const UUID_SECRET_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function redactString(value) {
  return String(value)
    .replace(PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(SECRET_PAIR_RE, (_match, key, separator, quote = '') => `${key}${separator}${quote}[REDACTED]${quote}`)
    .replace(UUID_SECRET_RE, '[REDACTED_UUID]')
    .replace(SECRET_KEY_RE, (key) => key);
}

export function redactSecrets(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    const error = new Error(redactString(value.message));
    error.name = value.name;
    if (value.stack) error.stack = redactString(value.stack);
    return error;
  }
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));

  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      next[key] = '[REDACTED]';
      SECRET_KEY_RE.lastIndex = 0;
    } else {
      SECRET_KEY_RE.lastIndex = 0;
      next[key] = redactSecrets(item, seen);
    }
  }
  return next;
}

export function safeWarn(...args) {
  console.warn(...args.map((arg) => redactSecrets(arg)));
}

export function safeInfo(...args) {
  console.info(...args.map((arg) => redactSecrets(arg)));
}

export function safeError(...args) {
  console.error(...args.map((arg) => redactSecrets(arg)));
}
