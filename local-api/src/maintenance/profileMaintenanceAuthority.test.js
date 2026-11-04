import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createProfileMaintenanceCommandService } from './profileMaintenanceCommandService.js';
import { createProfileMaintenanceTrustedRebuildSourceAdapters } from './profileMaintenanceTrustedRebuildSourceAdapters.js';

function fixture(t) {
  const db = createMigratedTestDb();
  const shopDb = createMigratedTestDb();
  t.after(() => { db.close(); shopDb.close(); });
  db.prepare("INSERT INTO shops(id, name, status) VALUES('authority-shop', 'Synthetic shop', 'active')").run();
  let direct = false;
  const service = createProfileMaintenanceCommandService({ db,
    trustedRebuildSourceAdapters: createProfileMaintenanceTrustedRebuildSourceAdapters({ db }),
    resolveShopDomainDatabase: () => ({ db: direct ? shopDb : db }),
  });
  const request = { command: 'rebuild-domain', domain: 'product-image-health' };
  return { db, shopDb, service, request, cutover() { direct = true; } };
}

test('profile-wide image health rebuild cannot report success against a frozen center after shop cutover', (t) => {
  const f = fixture(t);
  f.cutover();
  assert.throws(() => f.service.preview(f.request), { code: 'PROFILE_MAINTENANCE_SHOP_STORAGE_REQUIRED' });
});

test('a cutover after preview invalidates trusted rebuild ticket admission', (t) => {
  const f = fixture(t);
  const preview = f.service.preview(f.request);
  f.cutover();
  assert.throws(() => f.service.issueTrustedRebuildTicket({ domain: f.request.domain,
    humanConfirmationToken: preview.humanConfirmationToken }), { code: 'PROFILE_MAINTENANCE_SHOP_STORAGE_REQUIRED' });
});

test('a cutover after trusted ticket issuance prevents destructive center activation', (t) => {
  const f = fixture(t);
  const preview = f.service.preview(f.request);
  const ticket = f.service.issueTrustedRebuildTicket({ domain: f.request.domain, humanConfirmationToken: preview.humanConfirmationToken });
  f.cutover();
  assert.throws(() => f.service.confirm({ ...f.request, confirmation: preview.confirmation,
    humanConfirmationToken: preview.humanConfirmationToken, trustedSourceTicket: ticket.trustedSourceTicket }),
  { code: 'PROFILE_MAINTENANCE_SHOP_STORAGE_REQUIRED' });
});
