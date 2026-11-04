import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app, safeStorage } from 'electron';
import { createLicenseRuntime } from '../src/licensing/licenseRuntime.js';

const directory = path.resolve(process.argv[2]);
assert.ok(/[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work[\\/]authorization$/i.test(directory));
const dataRoot = path.join(directory, 'desktop-auth-profile');
assert.equal(fs.existsSync(dataRoot), false); fs.mkdirSync(dataRoot);
app.setPath('userData', dataRoot);
process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = '1';
process.env.WANGZAI_LICENSE_MODE = 'enforce';
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.private.json'), 'utf8'));
const distribution = JSON.parse(fs.readFileSync(path.join(directory, 'client/resources/distribution.json'), 'utf8'));
let calls = 0;
const checkedFetch = (url, options) => {
  assert.equal(new URL(url).origin, distribution.license_center_url); calls++;
  return fetch(url, options);
};
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'SAFE_STORAGE_UNAVAILABLE');
  const runtime = createLicenseRuntime({ app, safeStorage, desktopRoot: path.join(directory, 'client'), fetchImpl: checkedFetch });
  assert.equal((await runtime.getSession()).authorized, false);
  const login = await runtime.request({ method: 'POST', path: '/api/auth/login', body: {
    email: credentials.email, password: credentials.password,
  } });
  assert.equal(login.ok, true, login.error);
  for (const [index, shopId] of credentials.shopIds.entries()) {
    const result = await runtime.request({ method: 'POST', path: '/api/license/activate-shop', body: {
      card_key: credentials.cards[index], shop_id: shopId, shop_name: `隔离店铺 ${index + 1}`,
    } });
    assert.equal(result.ok, true, result.error);
  }
  // Add-on shop cards intentionally do not replace the desktop's current
  // session. Adopt the normal checked license exactly as the login UI does.
  const checked = await runtime.request({ method: 'POST', path: '/api/license/check', body: {} });
  assert.equal(checked.ok, true, checked.error);
  const session = await runtime.getSession();
  assert.equal(session.authorized, true, 'SESSION_NOT_AUTHORIZED');
  const entitlements = await runtime.request({ method: 'GET', path: '/api/license/entitlements' });
  assert.equal(entitlements.ok, true, entitlements.error);
  const grants = await runtime.getOzonShopEntitlementGrants();
  assert.deepEqual(grants.map(item => item.clientId).sort(), credentials.shopIds.slice().sort());
  await assert.rejects(runtime.assertOzonShopEntitled('unlicensed-fixture'));
  const report = { actualLicenseRuntime: true, enforced: true, authorized: session.authorized,
    permissions: session.entitlement?.permissions, calls, entitlements: entitlements.data?.length,
    grants, createdWindows: false, realCredentialsUsed: false };
  fs.writeFileSync(path.join(directory, 'client-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ authorized: true, entitlements: report.entitlements, calls }));
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
