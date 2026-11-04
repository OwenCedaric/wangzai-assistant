const SECRET_PATTERNS = [
  /api[-_ ]?key/iu,
  /token/iu,
  /client[-_ ]?id/iu,
  /secret/iu,
  /authorization/iu,
];

export function redactSensitiveValue(value) {
  if (value == null) {
    return value;
  }
  return '[REDACTED]';
}

export function safeLogPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map((item) => safeLogPayload(item));
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      const shouldRedact = SECRET_PATTERNS.some((pattern) => pattern.test(key));
      return [key, shouldRedact ? redactSensitiveValue(value) : safeLogPayload(value)];
    }),
  );
}

export function safeLog(message, payload = undefined) {
  if (payload === undefined) {
    console.log(message);
    return;
  }
  console.log(message, JSON.stringify(safeLogPayload(payload), null, 2));
}

