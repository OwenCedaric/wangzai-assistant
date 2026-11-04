import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('cross-border account routes persist only the opaque management authorization for the server-managed flow', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/api/logistics/cross-border/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'cross-border-main',
        name: '跨境巴士主授权',
        status: 'active',
        authorizationRef: 'opaque-management-route-authorization',
        authorizationExpiresAt: '2026-09-30T00:00:00Z',
      }),
    });
    const saved = await response.json();

    assert.equal(response.status, 200);
    assert.equal(saved.account.hasServerAuthorization, true);
    assert.equal(saved.account.authorizationRef, 'opaque-management-route-authorization');
    assert.equal(saved.account.hasCompanySecret, false);
    assert.equal(saved.account.hasAccessToken, false);

    const listResponse = await fetch(`${baseUrl}/api/logistics/cross-border/accounts`);
    const listed = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].hasServerAuthorization, true);
    assert.equal(listed.rows[0].authorizationRef, 'opaque-management-route-authorization');
    assert.equal(listed.rows[0].authorizationExpiresAt, '2026-09-30T00:00:00Z');
    assert.equal(listed.rows[0].hasCompanySecret, false);
    assert.equal(listed.rows[0].hasAccessToken, false);

    const row = db.prepare(`
      SELECT authorization_ref_encrypted, company_secret_encrypted, access_token_encrypted
      FROM cross_border_accounts WHERE id = ?
    `).get('cross-border-main');
    assert.match(row.authorization_ref_encrypted, /^secretbox:v1:/);
    assert.equal(row.authorization_ref_encrypted.includes('opaque-management-route-authorization'), false);
    assert.equal(row.company_secret_encrypted, null);
    assert.equal(row.access_token_encrypted, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
