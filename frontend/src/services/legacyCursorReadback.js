function toSafeTotal(value) {
  const total = Number(value);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function normalizeCursor(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStableValue(value) {
  if (Array.isArray(value)) return value.map(normalizeStableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((output, key) => {
        const normalized = normalizeStableValue(value[key]);
        if (normalized !== undefined) output[key] = normalized;
        return output;
      }, {});
  }
  return value;
}

/**
 * Browser-safe deterministic fingerprint for migration readback. It is not a
 * secret hash and must only receive public canonical DTOs.
 */
export function createStableLegacyDigest(value) {
  const text = JSON.stringify(normalizeStableValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Reads a typed local-api cursor route to completion. A missing total,
 * hasMore, nextCursor, repeated cursor, changing total, or final count
 * mismatch is a failed readback; callers must retain their legacy source.
 */
export async function readEveryCursorPage(readPage, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 1000, 1), 1000);
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 10000, 1), 10000);
  const rows = [];
  const seenCursors = new Set();
  let cursor = '';
  let total = null;
  let pageCount = 0;

  while (pageCount < maxPages) {
    let result;
    try {
      result = await readPage({ cursor, limit: pageSize, cursorMode: 'legacy-migration' });
    } catch (error) {
      return {
        complete: false,
        rows: [],
        total: null,
        pageCount,
        pageLimitReached: false,
        error,
      };
    }
    pageCount += 1;
    const pageRows = Array.isArray(result?.rows) ? result.rows : null;
    const pageTotal = toSafeTotal(result?.total);
    const hasMore = result?.hasMore;
    const nextCursor = normalizeCursor(result?.nextCursor);

    if (pageRows === null || pageTotal === null || typeof hasMore !== 'boolean') {
      return {
        complete: false,
        rows: [],
        total: pageTotal,
        pageCount,
        pageLimitReached: false,
        reason: 'CURSOR_PAGE_SHAPE_INVALID',
      };
    }
    if (total === null) total = pageTotal;
    if (total !== pageTotal || rows.length + pageRows.length > total) {
      return {
        complete: false,
        rows: [],
        total,
        pageCount,
        pageLimitReached: false,
        reason: 'CURSOR_PAGE_TOTAL_MISMATCH',
      };
    }
    rows.push(...pageRows);

    if (!hasMore) {
      if (nextCursor || rows.length !== total) {
        return {
          complete: false,
          rows: [],
          total,
          pageCount,
          pageLimitReached: false,
          reason: 'CURSOR_PAGE_INCOMPLETE',
        };
      }
      return {
        complete: true,
        rows,
        total,
        pageCount,
        pageLimitReached: false,
      };
    }

    if (!nextCursor || seenCursors.has(nextCursor)) {
      return {
        complete: false,
        rows: [],
        total,
        pageCount,
        pageLimitReached: false,
        reason: 'CURSOR_NEXT_CURSOR_INVALID',
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    complete: false,
    rows: [],
    total,
    pageCount,
    pageLimitReached: true,
    reason: 'CURSOR_PAGE_LIMIT_REACHED',
  };
}
