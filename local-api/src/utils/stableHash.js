import { createHash } from 'node:crypto';

function normalizeForStableStringify(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const normalized = normalizeForStableStringify(value[key]);
        if (normalized !== undefined) {
          acc[key] = normalized;
        }
        return acc;
      }, {});
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeForStableStringify(value));
}

export function createStableHash(value, { length = 64 } = {}) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const digest = createHash('sha256').update(text ?? '', 'utf8').digest('hex');
  return length ? digest.slice(0, length) : digest;
}
