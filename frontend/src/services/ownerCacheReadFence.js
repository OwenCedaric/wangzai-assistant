function normalizeIdentifiers(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean))];
}

/**
 * Tickets exist only for in-flight reads. Invalidating one is irreversible;
 * releasing a caller's admission fence cannot revive it. No owner epoch or
 * completed-owner tombstone is retained here.
 */
export function createOwnerCacheReadFence() {
  const readsByIdentifier = new Map();

  function unlink(record) {
    for (const identifier of record.identifiers) {
      const reads = readsByIdentifier.get(identifier);
      reads?.delete(record);
      if (reads?.size === 0) readsByIdentifier.delete(identifier);
    }
    record.identifiers = [];
  }

  function capture(identifiers) {
    const normalized = normalizeIdentifiers(identifiers);
    if (!normalized.length) throw new Error('OWNER_CACHE_READ_SCOPE_REQUIRED');
    const record = { current: true, identifiers: normalized, ticket: null };
    const ticket = Object.freeze({
      get current() { return record.current; },
      finish() { record.current = false; unlink(record); },
    });
    record.ticket = ticket;
    for (const identifier of normalized) {
      const reads = readsByIdentifier.get(identifier) || new Set();
      reads.add(record);
      readsByIdentifier.set(identifier, reads);
    }
    return ticket;
  }

  function invalidate(identifiers, promiseCache = null) {
    const records = new Set(normalizeIdentifiers(identifiers)
      .flatMap((identifier) => [...(readsByIdentifier.get(identifier) || [])]));
    const tickets = new Set();
    for (const record of records) {
      record.current = false;
      tickets.add(record.ticket);
      unlink(record);
    }
    let removedCacheEntries = 0;
    // A client-id fence also removes its exact shop-keyed pending entry. Do
    // not parse an ambiguous key prefix or evict another owner's pending read.
    if (promiseCache) {
      for (const [key, entry] of promiseCache) {
        if (!tickets.has(entry?.readTicket)) continue;
        promiseCache.delete(key);
        removedCacheEntries += 1;
      }
    }
    return { invalidatedReads: records.size, removedCacheEntries };
  }

  function snapshot() {
    const reads = new Set([...readsByIdentifier.values()].flatMap((records) => [...records]));
    return { activeReads: reads.size, indexedIdentifiers: readsByIdentifier.size };
  }

  return Object.freeze({ capture, invalidate, snapshot });
}
