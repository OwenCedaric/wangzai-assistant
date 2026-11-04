import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createExternalOzonIdentityHash,
  createShopIdentityRepository,
} from './repositories/shopIdentityRepository.js';

function migration(name) {
  return readFileSync(resolve('src/db/migrations', name), 'utf8').replace(/^\uFEFF/u, '');
}

test('migration 058 safely scopes existing shops and creates lifecycle tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration('001_create_base_tables.sql'));
  db.prepare(`
    INSERT INTO shops (id, name, client_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('legacy-active', 'Legacy active', 'Client-100', 'active', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  db.prepare(`
    INSERT INTO shops (id, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-disabled', 'Legacy disabled', 'disabled', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z');

  db.exec(migration('058_create_shop_identity_lifecycle.sql'));

  const active = db.prepare('SELECT * FROM shops WHERE id = ?').get('legacy-active');
  assert.equal(active.profile_id, 'default');
  assert.equal(active.shop_incarnation, 'legacy:legacy-active');
  assert.equal(active.credential_revision, 1);
  assert.equal(active.bound_at, '2026-01-01T00:00:00.000Z');
  assert.equal(active.disabled_at, null);
  assert.equal(active.external_identity_hash, null);

  const disabled = db.prepare('SELECT * FROM shops WHERE id = ?').get('legacy-disabled');
  assert.equal(disabled.shop_incarnation, 'legacy:legacy-disabled');
  assert.equal(disabled.disabled_at, '2026-02-02T00:00:00.000Z');

  db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)')
    .run('post-migration-direct-insert', 'Direct restore row', 'inactive');
  const directInsert = db.prepare('SELECT shop_incarnation, bound_at FROM shops WHERE id = ?')
    .get('post-migration-direct-insert');
  assert.match(directInsert.shop_incarnation, /^inc_sql_[a-f0-9]{32}$/u);
  assert.ok(directInsert.bound_at);
  assert.throws(
    () => db.prepare('INSERT INTO shops (id, name, client_id) VALUES (?, ?, ?)')
      .run('post-migration-duplicate', 'Duplicate', ' client-100 '),
    /SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND/u,
  );

  const identityRepository = createShopIdentityRepository(db);
  assert.equal(identityRepository.backfill.updatedCount, 1);
  assert.equal(
    db.prepare('SELECT external_identity_hash FROM shops WHERE id = ?').get('legacy-active').external_identity_hash,
    createExternalOzonIdentityHash('client-100'),
  );
  assert.deepEqual(
    db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'shop_identity_tombstones', 'shop_bootstrap_runs', 'shop_domain_sync_state'
      ) ORDER BY name
    `).all().map((row) => row.name),
    ['shop_bootstrap_runs', 'shop_domain_sync_state', 'shop_identity_tombstones'],
  );
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 58);
  db.close();
});

test('legacy duplicate external identities remain protected instead of being guessed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('001_create_base_tables.sql'));
  db.prepare('INSERT INTO shops (id, name, client_id) VALUES (?, ?, ?)').run('legacy-a', 'A', 'same-client');
  db.prepare('INSERT INTO shops (id, name, client_id) VALUES (?, ?, ?)').run('legacy-b', 'B', ' SAME-CLIENT ');
  db.exec(migration('058_create_shop_identity_lifecycle.sql'));

  const identityRepository = createShopIdentityRepository(db);
  assert.equal(identityRepository.backfill.conflicts.length, 1);
  assert.deepEqual(identityRepository.backfill.conflicts[0].shopIds, ['legacy-a', 'legacy-b']);
  assert.throws(
    () => identityRepository.assertExternalIdentityAvailable({ clientId: 'same-client', excludeShopId: 'new-shop' }),
    (error) => error?.code === 'SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND',
  );
  db.close();
});
