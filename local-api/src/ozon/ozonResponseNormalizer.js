import { createStableHash } from '../utils/stableHash.js';
import { getOzonEndpoint } from './ozonEndpointRegistry.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getByPath(source, path = '') {
  if (!path) return undefined;
  return path.split('.').reduce((current, part) => {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    return current?.[part];
  }, source);
}

function rowsFromValue(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return [value];
  return null;
}

function getRows(data, endpointKey) {
  const endpointRows = rowsFromValue(getByPath(data, getOzonEndpoint(endpointKey)?.responseShape?.itemsPath));
  if (endpointRows) return endpointRows;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.values)) return data.values;
  if (Array.isArray(data?.categories)) return data.categories;
  if (Array.isArray(data?.returns)) return data.returns;
  if (isPlainObject(data?.returns)) return [data.returns];
  return [];
}

export function normalizeOzonResponse({ domain, endpointKey, response, params = {}, status = 'confirmed' } = {}) {
  const data = response?.data ?? response ?? null;
  const rows = getRows(data, endpointKey);
  const partial = Boolean(response?.partial || data?.partial || status === 'partial');
  const remoteHash = createStableHash(data, { length: 32 });
  const payloadHash = createStableHash(params, { length: 32 });

  return {
    ok: Boolean(response?.ok ?? true),
    domain,
    endpointKey,
    status: partial ? 'partial' : 'confirmed',
    partial,
    data,
    rows,
    rowCount: rows.length,
    remoteHash,
    payloadHash,
    receivedAt: response?.receivedAt || new Date().toISOString(),
    httpStatus: response?.status || null,
  };
}

export function createOzonResponseNormalizer() {
  return {
    normalize: normalizeOzonResponse,
  };
}
