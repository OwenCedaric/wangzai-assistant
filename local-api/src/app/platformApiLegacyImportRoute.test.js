import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createTestServer(db) {
  return createApp({
    db,
    config: { security: {}, sync: {}, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
  });
}

test('platform configuration uses normal SQLite routes and retired browser import routes are unavailable', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createTestServer(db);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const profileResponse = await fetch(`${baseUrl}/api/integrations/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'sqlite-platform-a',
        integrationType: 'tool',
        platformName: 'SQLite Platform',
      }),
    });
    assert.equal(profileResponse.status, 200);

    const accountResponse = await fetch(`${baseUrl}/api/performance/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'sqlite-performance-a',
        name: 'SQLite Performance',
        clientId: 'sqlite-client',
        clientSecret: 'sqlite-route-secret',
      }),
    });
    const accountSaved = await accountResponse.json();
    assert.equal(accountResponse.status, 200);
    assert.equal(accountSaved.account.hasClientSecret, true);
    assert.equal(JSON.stringify(accountSaved).includes('sqlite-route-secret'), false);

    const profiles = await (await fetch(`${baseUrl}/api/integrations/profiles`)).json();
    const accounts = await (await fetch(`${baseUrl}/api/performance/accounts`)).json();
    assert.deepEqual(profiles.profiles.map((profile) => profile.id), ['sqlite-platform-a']);
    assert.deepEqual(accounts.accounts.map((account) => account.id), ['sqlite-performance-a']);
    assert.equal(JSON.stringify(accounts).includes('sqlite-route-secret'), false);

    for (const path of [
      '/api/integrations/profiles/legacy-import',
      '/api/performance/accounts/legacy-import',
    ]) {
      const retired = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [] }),
      });
      assert.equal(retired.status, 404);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
