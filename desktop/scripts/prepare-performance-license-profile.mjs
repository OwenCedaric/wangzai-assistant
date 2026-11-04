import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, safeStorage } from 'electron';
import { createLicenseRuntime } from '../src/licensing/licenseRuntime.js';
import { LicenseSessionStore } from '../src/licensing/licenseSessionStore.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownedTemplateParent = path.join(desktopRoot, '.desktop-performance-license-template');
const argument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || '';
};
const dataRoot = path.resolve(argument('data-root'));
const credentialsPath = path.resolve(argument('credentials-file'));
const consumeCredentials = process.argv.includes('--consume-credentials');

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

if (!inside(ownedTemplateParent, dataRoot)) {
  throw new Error('PERFORMANCE_LICENSE_PROFILE_OUTSIDE_OWNED_ROOT');
}
const credentialsStat = await fs.lstat(credentialsPath);
if (
  !credentialsStat.isFile()
  || credentialsStat.isSymbolicLink()
  || credentialsStat.nlink !== 1
  || credentialsStat.size < 1
  || credentialsStat.size > 32 * 1024
) {
  throw new Error('PERFORMANCE_LICENSE_CREDENTIALS_INVALID');
}
const credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
const username = String(credentials.username || '').trim();
const password = String(credentials.password || '');
const cardKey = String(credentials.cardKey || credentials.card_key || '').trim();
const requiredPermissions = Array.isArray(credentials.requiredPermissions)
  ? credentials.requiredPermissions.map((value) => String(value || '').trim()).filter(Boolean)
  : ['products.view', 'orders.view'];
if (!username || !password || !cardKey || requiredPermissions.length < 1) {
  throw new Error('PERFORMANCE_LICENSE_CREDENTIALS_FIELDS_INVALID');
}

await fs.mkdir(dataRoot, { recursive: false });
app.setPath('userData', dataRoot);
async function preparePerformanceLicenseProfile() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('PERFORMANCE_LICENSE_SAFE_STORAGE_UNAVAILABLE');
  }
  const distribution = JSON.parse(
    await fs.readFile(path.join(desktopRoot, 'resources', 'distribution.json'), 'utf8'),
  );
  if (
    distribution.license_mode !== 'enforce'
    || distribution.campaign_code !== 'test-fixture'
  ) {
    throw new Error('PERFORMANCE_LICENSE_REQUIRES_TEST_FIXTURE_DISTRIBUTION');
  }
  const serverUrl = String(distribution.license_center_url || '').replace(/\/+$/u, '');
  const store = new LicenseSessionStore({
    directory: path.join(dataRoot, 'license'),
    safeStorage,
  });
  const deviceCode = await store.getDeviceCode();
  const response = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const login = await response.json().catch(() => ({}));
  if (!response.ok || !login.access_token) {
    throw new Error(`PERFORMANCE_LICENSE_LOGIN_FAILED:${response.status}`);
  }
  await store.save({
    userAccessToken: String(login.access_token),
    // Username/password fixture login deliberately returns no refresh token;
    // SMS verification is the only License Center flow that issues one.
    refreshToken: login.refresh_token ? String(login.refresh_token) : '',
    user: login.user && typeof login.user === 'object' ? login.user : null,
  });
  const runtime = createLicenseRuntime({
    app,
    safeStorage,
    desktopRoot,
    resourcesPath: process.resourcesPath,
  });
  const runtimeInfo = await runtime.getRuntime();
  if (runtimeInfo.deviceCode !== deviceCode || runtimeInfo.campaignCode !== 'test-fixture') {
    throw new Error('PERFORMANCE_LICENSE_DEVICE_OR_CAMPAIGN_MISMATCH');
  }
  const activated = await runtime.request({
    method: 'POST',
    path: '/api/license/activate',
    body: { card_key: cardKey },
  });
  if (!activated.ok) {
    throw new Error(`PERFORMANCE_LICENSE_ACTIVATION_FAILED:${activated.status}`);
  }
  const snapshot = await runtime.getSession();
  const permissions = new Set(snapshot.entitlement?.permissions || []);
  const missing = requiredPermissions.filter((permission) => {
    const base = permission.split('.')[0];
    return !permissions.has(permission) && !permissions.has(base);
  });
  if (!snapshot.authorized || !snapshot.persistent || missing.length) {
    throw new Error(`PERFORMANCE_LICENSE_ENTITLEMENT_INVALID:${missing.join(',')}`);
  }
  const entries = (await fs.readdir(path.join(dataRoot, 'license'))).sort();
  if (JSON.stringify(entries) !== JSON.stringify(['license-device-id', 'license-session.bin'])) {
    throw new Error('PERFORMANCE_LICENSE_PROFILE_FILESET_INVALID');
  }
  const rootEntries = (await fs.readdir(dataRoot)).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(['Local State', 'license'])) {
    throw new Error('PERFORMANCE_LICENSE_PROFILE_ROOT_FILESET_INVALID');
  }
  console.log(JSON.stringify({
    ok: true,
    contract: 'signed-performance-license-template/v1',
    authorized: true,
    persistent: true,
    campaignCode: runtimeInfo.campaignCode,
    permissions: [...permissions].sort(),
    credentialsPersisted: false,
  }));
}

async function finish(error = null) {
  if (consumeCredentials) {
    await fs.rm(credentialsPath, { force: true }).catch(() => undefined);
  }
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  app.exit(error ? 1 : 0);
}

// Do not top-level await app.whenReady(): Electron does not emit `ready` until
// the ESM entry module has finished evaluating, so awaiting it here deadlocks.
app.whenReady()
  .then(preparePerformanceLicenseProfile)
  .then(() => finish(), (error) => finish(error));
