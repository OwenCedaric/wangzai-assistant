import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createExchangeRateCacheRepository } from '../src/db/repositories/exchangeRateCacheRepository.js';
import { createMigratedTestDb } from './testDb.js';

test('exchange-rate cache stores compact per-date rows and replaces the same requested date', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createExchangeRateCacheRepository(db);
    repository.saveRecords({ records: [{
      requestedDate: '2026-07-10',
      date: '2026-07-10',
      mode: 'daily',
      rubToCnyRate: 0.0895,
      source: 'cbr',
      immutable: true,
    }] });
    repository.saveRecords({ records: [{
      requestedDate: '2026-07-10',
      date: '2026-07-10',
      mode: 'daily',
      rubToCnyRate: 0.0896,
      source: 'cbr-official',
      immutable: true,
    }, {
      requestedDate: '2026-07-12',
      date: '2026-07-12',
      mode: 'realtime',
      rubToCnyRate: 0.0888,
      expiresAt: '2026-07-12T01:00:00.000Z',
      immutable: false,
    }] });

    const listed = repository.listRecords();
    assert.equal(listed.records.length, 2);
    assert.equal(listed.records.find((row) => row.requestedDate === '2026-07-10').rubToCnyRate, 0.0896);
    assert.equal(listed.records.find((row) => row.requestedDate === '2026-07-12').immutable, false);
  } finally {
    db.close();
  }
});

test('exchange-rate cache routes are local-only and reject an invalid rate', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false } },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const saved = await (await fetch(`${base}/api/exchange-rate/rub-cny/cache`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: [{ requestedDate: '2026-07-12', date: '2026-07-12', mode: 'realtime', rubToCnyRate: 0.0888 }] }),
    })).json();
    assert.equal(saved.ok, true);
    const listed = await (await fetch(`${base}/api/exchange-rate/rub-cny/cache`)).json();
    assert.equal(listed.records.length, 1);
    const invalid = await (await fetch(`${base}/api/exchange-rate/rub-cny/cache`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: [{ requestedDate: '2026-07-12', date: '2026-07-12', rubToCnyRate: 0 }] }),
    })).json();
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'EXCHANGE_RATE_VALUE_REQUIRED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
