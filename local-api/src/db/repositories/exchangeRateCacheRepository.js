function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeDateKey(value) {
  const text = normalizeText(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : '';
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRecord(input = {}) {
  const requestedDate = normalizeDateKey(input.requestedDate ?? input.requested_date ?? input.date);
  const rateDate = normalizeDateKey(input.date ?? input.rateDate ?? input.rate_date ?? requestedDate);
  const rate = toFiniteNumber(input.rubToCnyRate ?? input.rub_to_cny_rate ?? input.rate);
  if (!requestedDate) throw new Error('EXCHANGE_RATE_REQUESTED_DATE_REQUIRED');
  if (!rateDate) throw new Error('EXCHANGE_RATE_DATE_REQUIRED');
  if (rate === null || rate <= 0) throw new Error('EXCHANGE_RATE_VALUE_REQUIRED');
  const lookbackDaysUsed = toFiniteNumber(input.lookbackDaysUsed ?? input.lookback_days_used);
  return {
    requestedDate,
    date: rateDate,
    mode: normalizeText(input.mode) || 'daily',
    nearestFallback: Boolean(input.nearestFallback ?? input.nearest_fallback),
    lookbackDaysUsed: lookbackDaysUsed === null ? null : Math.max(0, Math.floor(lookbackDaysUsed)),
    rubToCnyRate: rate,
    source: normalizeText(input.source),
    fetchedAt: normalizeText(input.fetchedAt ?? input.fetched_at),
    expiresAt: normalizeText(input.expiresAt ?? input.expires_at),
    immutable: input.immutable === undefined ? true : Boolean(input.immutable),
  };
}

function toPublicRecord(row = {}) {
  return {
    requestedDate: row.requested_date || '',
    date: row.rate_date || '',
    mode: row.mode || 'daily',
    nearestFallback: Boolean(row.nearest_fallback),
    lookbackDaysUsed: row.lookback_days_used === null || row.lookback_days_used === undefined ? null : Number(row.lookback_days_used),
    rubToCnyRate: Number(row.rub_to_cny_rate),
    rate: Number(row.rub_to_cny_rate),
    source: row.source || '',
    fetchedAt: row.fetched_at || '',
    expiresAt: row.expires_at || '',
    immutable: Boolean(row.immutable),
    updatedAt: row.updated_at || '',
  };
}

export function createExchangeRateCacheRepository(db) {
  if (!db) throw new Error('createExchangeRateCacheRepository requires db.');

  function listRecords(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 2000, 1), 5000);
    const rows = db.prepare(`
      SELECT * FROM exchange_rate_cache
      ORDER BY requested_date DESC
      LIMIT ?
    `).all(limit);
    return { ok: true, records: rows.map(toPublicRecord) };
  }

  function saveRecords(input = {}) {
    const source = Array.isArray(input) ? input : input.records;
    const records = (Array.isArray(source) ? source : []).map(normalizeRecord);
    if (!records.length) return { ok: true, changed: 0, records: [] };
    const timestamp = nowIso();
    const upsert = db.prepare(`
      INSERT INTO exchange_rate_cache (
        requested_date, mode, rate_date, nearest_fallback, lookback_days_used,
        rub_to_cny_rate, source, fetched_at, expires_at, immutable, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(requested_date) DO UPDATE SET
        mode = excluded.mode,
        rate_date = excluded.rate_date,
        nearest_fallback = excluded.nearest_fallback,
        lookback_days_used = excluded.lookback_days_used,
        rub_to_cny_rate = excluded.rub_to_cny_rate,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        immutable = excluded.immutable,
        updated_at = excluded.updated_at
    `);
    db.exec('BEGIN;');
    try {
      records.forEach((record) => {
        upsert.run(
          record.requestedDate,
          record.mode,
          record.date,
          record.nearestFallback ? 1 : 0,
          record.lookbackDaysUsed,
          record.rubToCnyRate,
          record.source || null,
          record.fetchedAt || null,
          record.expiresAt || null,
          record.immutable ? 1 : 0,
          timestamp,
        );
      });
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    const requestedDates = records.map((record) => record.requestedDate);
    const placeholders = requestedDates.map(() => '?').join(',');
    const saved = db.prepare(`SELECT * FROM exchange_rate_cache WHERE requested_date IN (${placeholders})`).all(...requestedDates);
    return { ok: true, changed: records.length, records: saved.map(toPublicRecord) };
  }

  return { listRecords, saveRecords };
}
