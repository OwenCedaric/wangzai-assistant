// Public data contract only. No formula or private workflow implementation.
export const PRIVATE_PROFIT_VERSION = 'profit-ledger-v16-partial-compensation-net-income';
export const PRIVATE_PROFIT_OPERATIONS = new Set(['ledger', 'normalize', 'rebuild-final', 'manual-override', 'merge-ledger', 'migrate-ledger']);
export const PRIVATE_PROFIT_MAX_WIRE_BYTES = 1024 * 1024;
const FORBIDDEN = /^(?:__proto__|prototype|constructor)$|(?:^|[_-])(?:api[_-]?key|client[_-]?id|client[_-]?secret|password|passwd|cookie|authorization|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|ozon[_-]?key|secret)(?:$|[_-])/iu;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function encodeProfitWire(input) {
  const active = new WeakSet(); let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 100_000 || depth > 48) fail('PROFIT_CORE_WIRE_LIMIT');
    if (value === undefined) return { t: 'undefined' };
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PROFIT_CORE_NONFINITE'); return value; }
    if (typeof value === 'bigint') return { t: 'bigint', v: String(value) };
    if (typeof value !== 'object' || active.has(value)) fail('PROFIT_CORE_UNSERIALIZABLE');
    active.add(value);
    try {
      if (value instanceof Date) return { t: 'date', v: value.toISOString() };
      if (value instanceof Map) return { t: 'map', v: [...value].map(([k, v]) => [visit(k, depth + 1), visit(v, depth + 1)]) };
      if (value instanceof Set) return { t: 'set', v: [...value].map(v => visit(v, depth + 1)) };
      if (Array.isArray(value)) return { t: 'array', v: value.map(v => visit(v, depth + 1)) };
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('PROFIT_CORE_UNSERIALIZABLE');
      return { t: 'object', v: Object.entries(value).map(([key, v]) => {
        if (FORBIDDEN.test(key)) fail('PROFIT_CORE_SECRET_REJECTED');
        return [key, visit(v, depth + 1)];
      }) };
    } finally { active.delete(value); }
  };
  return visit(input);
}

export function decodeProfitWire(input) {
  let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 100_000 || depth > 48) fail('PROFIT_CORE_WIRE_LIMIT');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PROFIT_CORE_NONFINITE'); return value; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROFIT_CORE_WIRE_INVALID');
    if (value.t === 'undefined' && Object.keys(value).length === 1) return undefined;
    if (Object.keys(value).sort().join(',') !== 't,v') fail('PROFIT_CORE_WIRE_INVALID');
    if (value.t === 'date') {
      const date = new Date(value.v);
      if (typeof value.v !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== value.v) fail('PROFIT_CORE_WIRE_INVALID');
      return date;
    }
    if (value.t === 'bigint') {
      if (typeof value.v !== 'string' || !/^-?\d{1,40}$/u.test(value.v)) fail('PROFIT_CORE_WIRE_INVALID');
      return BigInt(value.v);
    }
    if (!Array.isArray(value.v)) fail('PROFIT_CORE_WIRE_INVALID');
    if (value.t === 'array') return value.v.map(v => visit(v, depth + 1));
    if (value.t === 'set') return new Set(value.v.map(v => visit(v, depth + 1)));
    if (value.t === 'map' || value.t === 'object') {
      const keys = new Set();
      const pairs = value.v.map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2) fail('PROFIT_CORE_WIRE_INVALID');
        const key = value.t === 'object' ? pair[0] : visit(pair[0], depth + 1);
        if (value.t === 'object' && (typeof key !== 'string' || FORBIDDEN.test(key))) fail('PROFIT_CORE_SECRET_REJECTED');
        if (keys.has(key)) fail('PROFIT_CORE_DUPLICATE_KEY');
        keys.add(key);
        return [key, visit(pair[1], depth + 1)];
      });
      return value.t === 'map' ? new Map(pairs) : Object.fromEntries(pairs);
    }
    fail('PROFIT_CORE_WIRE_INVALID');
  };
  return visit(input);
}

export function createProfitCoreBatch(calls) {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 64) fail('PROFIT_CORE_BATCH_SIZE_INVALID');
  const seen = new Set();
  for (const call of calls) {
    if (!call || Object.keys(call).sort().join(',') !== 'id,input,operation' || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(call.id)
      || seen.has(call.id) || !PRIVATE_PROFIT_OPERATIONS.has(call.operation)
      || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
      || !call.input.order || typeof call.input.order !== 'object' || Array.isArray(call.input.order)
      || (['merge-ledger', 'migrate-ledger'].includes(call.operation) && !Object.hasOwn(call.input, 'ledger'))) fail('PROFIT_CORE_CALL_INVALID');
    seen.add(call.id);
  }
  const callsJson = JSON.stringify(encodeProfitWire(calls));
  if (new TextEncoder().encode(callsJson).length > PRIVATE_PROFIT_MAX_WIRE_BYTES) fail('PROFIT_CORE_BATCH_TOO_LARGE');
  return { calculationVersion: PRIVATE_PROFIT_VERSION, callsJson };
}

export function readProfitCoreResults(result, calls) {
  if (result?.calculationVersion !== PRIVATE_PROFIT_VERSION || typeof result.resultsJson !== 'string') fail('PROFIT_CORE_RESULT_VERSION_INVALID');
  if (new TextEncoder().encode(result.resultsJson).length > 16 * 1024 * 1024) fail('PROFIT_CORE_RESULT_TOO_LARGE');
  const values = decodeProfitWire(JSON.parse(result.resultsJson));
  if (!Array.isArray(values) || values.length !== calls.length || values.some((value, index) => !value || Object.keys(value).sort().join(',') !== 'id,value' || value.id !== calls[index].id)) fail('PROFIT_CORE_RESULT_RANGE_INVALID');
  return values.map(value => value.value);
}
