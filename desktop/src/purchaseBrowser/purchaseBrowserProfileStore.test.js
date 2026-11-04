import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPurchaseBrowserProfileStore, createSafeStorageProtector } from './purchaseBrowserProfileStore.js';

function reversibleTestProtector() {
  return {
    protect(value) {
      return Buffer.from(`test-protected:${Buffer.from(String(value), 'utf8').toString('base64')}`, 'utf8');
    },
    unprotect(value) {
      const text = Buffer.from(value).toString('utf8');
      return Buffer.from(text.slice('test-protected:'.length), 'base64').toString('utf8');
    },
  };
}

test('verified owner removal purges its recovery copy while preserving every other account', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-profile-remove-backup-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const options = { filePath, protector: reversibleTestProtector(), baseUserAgent: 'Mozilla/5.0 Test Chrome/150.0.0.0 Safari/537.36' };
  const a = { accountId: 'remove-a', accountIncarnation: '2026-09-05T00:00:00.000Z' };
  const b = { accountId: 'keep-b', accountIncarnation: '2026-09-05T00:00:00.000Z' };
  try {
    const store = createPurchaseBrowserProfileStore(options);
    store.getOrCreate(a);
    const kept = store.getOrCreate(b);
    store.remove(a);
    const backup = JSON.parse(options.protector.unprotect(Buffer.from(JSON.parse(readFileSync(`${filePath}.bak`, 'utf8')).ciphertext, 'base64')));
    assert.equal(Boolean(backup.profiles[store.ownerRefFor(a)]), false);
    assert.deepEqual(backup.profiles[kept.ownerRef], kept);
    writeFileSync(filePath, '{damaged-primary');
    const reopened = createPurchaseBrowserProfileStore(options);
    assert.equal(reopened.get(a), null);
    assert.deepEqual(reopened.get(b), kept);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('backup replacement failure cannot acknowledge removal and same-owner retry completes safely', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-profile-remove-failure-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const options = { filePath, protector: reversibleTestProtector(), baseUserAgent: 'Mozilla/5.0 Test Chrome/150.0.0.0 Safari/537.36' };
  const a = { accountId: 'remove-a', accountIncarnation: '2026-09-05T00:00:00.000Z' };
  const b = { accountId: 'keep-b', accountIncarnation: '2026-09-05T00:00:00.000Z' };
  const originalRename = fs.renameSync;
  try {
    const store = createPurchaseBrowserProfileStore(options);
    store.getOrCreate(a);
    const kept = store.getOrCreate(b);
    fs.renameSync = (source, destination) => {
      if (destination === `${filePath}.bak`) throw Object.assign(new Error('fixture backup busy'), { code: 'EBUSY' });
      return originalRename(source, destination);
    };
    assert.throws(() => store.remove(a), { code: 'EBUSY' });
    assert.deepEqual(store.get(b), kept);
    fs.renameSync = originalRename;
    store.remove(a);
    writeFileSync(filePath, '{damaged-primary');
    const reopened = createPurchaseBrowserProfileStore(options);
    assert.equal(reopened.get(a), null);
    assert.deepEqual(reopened.get(b), kept);
  } finally {
    fs.renameSync = originalRename;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('purchase browser profiles use encrypted HMAC owner references and stay stable across restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-profile-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const bindingA = { accountId: 'raw-purchase-account-A', accountIncarnation: '2026-07-15T00:00:00.000Z', platformName: '1688' };
  const bindingB = { accountId: 'raw-purchase-account-B', accountIncarnation: '2026-07-15T00:00:00.000Z', platformName: '淘宝' };
  try {
    const firstStore = createPurchaseBrowserProfileStore({
      filePath,
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/136.0.0.0 Safari/537.36',
    });
    const profileA = firstStore.getOrCreate(bindingA, {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      proxy: { mode: 'fixed_servers', rules: 'http=proxy-a.invalid:8080', credentialRef: 'proxy-secret-ref-a' },
    });
    const profileB = firstStore.getOrCreate(bindingB, {
      locale: 'zh-CN',
      timezone: 'Europe/Moscow',
      proxy: { mode: 'fixed_servers', rules: 'http=proxy-b.invalid:8081', credentialRef: 'proxy-secret-ref-b' },
    });
    assert.notEqual(profileA.ownerRef, profileB.ownerRef);
    assert.notEqual(profileA.partition, profileB.partition);
    assert.equal(profileA.platformKey, '1688');
    assert.equal(profileB.platformKey, 'taobao');
    assert.notEqual(profileA.fingerprint.seed, profileB.fingerprint.seed);
    assert.notEqual(profileA.acceptLanguage, profileB.acceptLanguage);
    assert.match(profileA.partition, /^persist:purchase-[a-f0-9]{40}$/u);
    const rawFile = readFileSync(filePath, 'utf8');
    assert.equal(rawFile.includes(bindingA.accountId), false);
    assert.equal(rawFile.includes('proxy-a.invalid'), false);
    assert.equal(rawFile.includes('proxy-secret-ref-a'), false);

    const restartedStore = createPurchaseBrowserProfileStore({
      filePath,
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 NewDefault Chrome/200.0.0.0 Safari/537.36',
    });
    assert.deepEqual(restartedStore.get(bindingA), profileA);
    assert.equal(restartedStore.get(bindingB).proxy.rules, 'http=proxy-b.invalid:8081');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('profile store recovers ten interrupted replacements from the verified backup', () => {
  for (let round = 0; round < 10; round += 1) {
    const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-profile-recovery-'));
    const filePath = path.join(directory, 'profiles.enc.json');
    const binding = {
      accountId: `recovery-account-${round}`,
      accountIncarnation: '2026-08-26T00:00:00.000Z',
      platformName: '拼多多',
    };
    try {
      const store = createPurchaseBrowserProfileStore({
        filePath,
        protector: reversibleTestProtector(),
        baseUserAgent: 'Mozilla/5.0 Test Chrome/150.0.0.0 Safari/537.36',
      });
      const expected = store.getOrCreate(binding);
      copyFileSync(filePath, `${filePath}.bak`);
      writeFileSync(filePath, '{broken', 'utf8');
      writeFileSync(`${filePath}.999.${round}.tmp`, 'orphan', 'utf8');
      const recovered = createPurchaseBrowserProfileStore({
        filePath,
        protector: reversibleTestProtector(),
        baseUserAgent: 'Mozilla/5.0 Test Chrome/150.0.0.0 Safari/537.36',
      });
      assert.equal(recovered.get(binding).ownerRef, expected.ownerRef);
      assert.equal(existsSync(`${filePath}.999.${round}.tmp`), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('same-platform accounts receive different stable fingerprints and platform binding never rotates an existing seed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-platform-profile-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/136.0.0.0 Safari/537.36',
    });
    const firstBinding = { accountId: 'purchase-1688-a', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' };
    const secondBinding = { accountId: 'purchase-1688-b', accountIncarnation: '2026-07-17T00:00:00.000Z', platformName: '1688' };
    const first = store.getOrCreate(firstBinding);
    const second = store.getOrCreate(secondBinding);
    assert.equal(first.platformKey, '1688');
    assert.equal(second.platformKey, '1688');
    assert.notEqual(first.fingerprint.seed, second.fingerprint.seed);

    const pendingPlatform = { accountId: 'purchase-platform-late', accountIncarnation: '2026-07-17T00:00:00.000Z' };
    const beforeBinding = store.getOrCreate(pendingPlatform);
    const afterBinding = store.getOrCreate({ ...pendingPlatform, platformName: '淘宝' });
    assert.equal(afterBinding.platformKey, 'taobao');
    assert.equal(afterBinding.fingerprint.seed, beforeBinding.fingerprint.seed);
    assert.equal(afterBinding.proxy.mode, 'direct');
    assert.equal(afterBinding.networkEnvironment.alignment, 'native-direct');
    assert.equal(afterBinding.networkEnvironment.timezoneSource, 'account-profile');
    assert.equal(afterBinding.networkEnvironment.webrtc, 'default');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deleted account profile cannot be recovered and same raw id rebind gets a new owner identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-profile-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/136.0.0.0 Safari/537.36',
    });
    const oldBinding = { accountId: 'purchase-same-id', accountIncarnation: '2026-07-15T00:00:00.000Z' };
    const newBinding = { accountId: 'purchase-same-id', accountIncarnation: '2026-07-16T00:00:00.000Z' };
    const oldProfile = store.getOrCreate(oldBinding);
    assert.equal(store.remove(oldBinding).existed, true);
    assert.equal(store.get(oldBinding), null);
    const newProfile = store.getOrCreate(newBinding);
    assert.notEqual(newProfile.ownerRef, oldProfile.ownerRef);
    assert.notEqual(newProfile.partition, oldProfile.partition);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('safeStorage profile protector fails closed instead of persisting plaintext', () => {
  const protector = createSafeStorageProtector({
    isEncryptionAvailable: () => false,
  });
  assert.throws(() => protector.protect('secret'), /PURCHASE_BROWSER_OS_ENCRYPTION_UNAVAILABLE/u);
  assert.throws(() => protector.unprotect(Buffer.from('secret')), /PURCHASE_BROWSER_OS_ENCRYPTION_UNAVAILABLE/u);
});

test('legacy Electron or Firefox user agents are replaced by the native CEF identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-ua-migration-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Native Chrome/149.0.0.0 Safari/537.36',
    });
    const binding = { accountId: 'legacy-ua', accountIncarnation: '2026-07-19T00:00:00.000Z', platformName: '淘宝' };
    const profile = store.getOrCreate(binding, {
      userAgent: 'Mozilla/5.0 Electron/43.1.0 Chrome/150.0.0.0 Safari/537.36',
    });
    assert.equal(profile.userAgent, 'Mozilla/5.0 Native Chrome/149.0.0.0 Safari/537.36');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('managed Chromium user agent advances with the bundled CEF major without rotating account identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-managed-ua-upgrade-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const protector = reversibleTestProtector();
  const binding = {
    accountId: 'ozon-managed-ua',
    accountIncarnation: '2026-08-19T00:00:00.000Z',
    platformName: 'Ozon',
  };
  const ua149 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
  const ua151 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  try {
    const oldStore = createPurchaseBrowserProfileStore({ filePath, protector, baseUserAgent: ua149 });
    const oldProfile = oldStore.getOrCreate(binding);
    const upgradedStore = createPurchaseBrowserProfileStore({ filePath, protector, baseUserAgent: ua151 });
    const upgradedProfile = upgradedStore.getOrCreate(binding);

    assert.equal(oldProfile.userAgent, ua149);
    assert.equal(upgradedProfile.userAgent, ua151);
    assert.equal(upgradedProfile.ownerRef, oldProfile.ownerRef);
    assert.equal(upgradedProfile.fingerprint.seed, oldProfile.fingerprint.seed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('managed Chromium user agent follows a CEF rollback without rotating cookies or account identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-managed-ua-rollback-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const protector = reversibleTestProtector();
  const binding = {
    accountId: 'ozon-managed-ua-rollback',
    accountIncarnation: '2026-08-22T00:00:00.000Z',
    platformName: 'Ozon',
  };
  const ua151 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  const ua150 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  try {
    const previousStore = createPurchaseBrowserProfileStore({ filePath, protector, baseUserAgent: ua151 });
    const previousProfile = previousStore.getOrCreate(binding);
    const currentStore = createPurchaseBrowserProfileStore({ filePath, protector, baseUserAgent: ua150 });
    const currentProfile = currentStore.getOrCreate(binding);

    assert.equal(previousProfile.userAgent, ua151);
    assert.equal(currentProfile.userAgent, ua150);
    assert.equal(currentProfile.ownerRef, previousProfile.ownerRef);
    assert.equal(currentProfile.fingerprint.seed, previousProfile.fingerprint.seed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct, system and fixed routes remain independently selectable', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-network-migration-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Native Chrome/151.0.0.0 Safari/537.36',
    });
    const directProfile = store.getOrCreate({
      accountId: 'direct-route',
      accountIncarnation: '2026-08-19T00:00:00.000Z',
      platformName: '淘宝',
    }, {
      proxy: { mode: 'direct' },
    });
    const systemProfile = store.getOrCreate({
      accountId: 'system-route',
      accountIncarnation: '2026-08-19T00:00:00.000Z',
      platformName: '淘宝',
    }, {
      proxy: { mode: 'system' },
    });
    const fixedProfile = store.getOrCreate({
      accountId: 'fixed-proxy',
      accountIncarnation: '2026-08-19T00:00:00.000Z',
      platformName: '1688',
    }, {
      proxy: { mode: 'fixed_servers', rules: 'http=proxy.invalid:8080' },
    });

    assert.equal(directProfile.proxy.mode, 'direct');
    assert.equal(directProfile.networkEnvironment.proxyRole, 'direct');
    assert.equal(systemProfile.proxy.mode, 'system');
    assert.equal(systemProfile.networkEnvironment.proxyRole, 'system');
    assert.equal(systemProfile.fingerprint.family, 'cef-stable-chromium-windows-platform-account');
    assert.equal(systemProfile.canvasPolicy, 'cef-stable');
    assert.equal(fixedProfile.proxy.mode, 'fixed_servers');
    assert.equal(fixedProfile.webrtcPolicy, 'disable_non_proxied_udp');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pinduoduo profiles always block non-proxied WebRTC UDP during checkout', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-pdd-webrtc-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Native Chrome/151.0.0.0 Safari/537.36',
    });
    const profile = store.getOrCreate({
      accountId: 'pdd-checkout',
      accountIncarnation: '2026-08-25T00:00:00.000Z',
      platformName: '拼多多',
    }, {
      proxy: { mode: 'direct' },
      webrtcPolicy: 'default',
    });

    assert.equal(profile.platformKey, 'pinduoduo');
    assert.equal(profile.webrtcPolicy, 'disable_non_proxied_udp');
    assert.equal(profile.networkEnvironment.webrtc, 'disable_non_proxied_udp');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the upgrade-only v2 system migration is restored to direct without overriding a later explicit system choice', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-network-restore-'));
  const filePath = path.join(directory, 'profiles.enc.json');
  const protector = reversibleTestProtector();
  const binding = {
    accountId: 'mistaken-system-route',
    accountIncarnation: '2026-08-19T00:00:00.000Z',
    platformName: 'Ozon买家',
  };
  try {
    const firstStore = createPurchaseBrowserProfileStore({
      filePath,
      protector,
      baseUserAgent: 'Mozilla/5.0 Native Chrome/151.0.0.0 Safari/537.36',
    });
    const created = firstStore.getOrCreate(binding, { proxy: { mode: 'system' } });
    const envelope = JSON.parse(readFileSync(filePath, 'utf8'));
    const document = JSON.parse(protector.unprotect(Buffer.from(envelope.ciphertext, 'base64')));
    document.profiles[created.ownerRef].networkEnvironment.version = 2;
    document.profiles[created.ownerRef].networkEnvironment.alignment = 'native-system';
    const ciphertext = Buffer.from(protector.protect(JSON.stringify(document))).toString('base64');
    writeFileSync(filePath, `${JSON.stringify({ version: 1, ciphertext })}\n`, 'utf8');

    const restartedStore = createPurchaseBrowserProfileStore({
      filePath,
      protector,
      baseUserAgent: 'Mozilla/5.0 Native Chrome/151.0.0.0 Safari/537.36',
    });
    const restored = restartedStore.getOrCreate(binding);
    assert.equal(restored.proxy.mode, 'direct');
    assert.equal(restored.networkEnvironment.version, 3);
    assert.equal(restored.networkEnvironment.alignment, 'native-direct');

    const explicitSystem = restartedStore.getOrCreate(binding, { proxy: { mode: 'system' } });
    const preservedSystem = restartedStore.getOrCreate(binding);
    assert.equal(explicitSystem.networkEnvironment.version, 3);
    assert.equal(preservedSystem.proxy.mode, 'system');
    assert.equal(preservedSystem.networkEnvironment.alignment, 'native-system');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Ozon browser profiles use the Ozon locale and Moscow timezone preset', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-ozon-profile-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/149.0.0.0 Safari/537.36',
    });
    const profile = store.getOrCreate({
      accountId: 'integration-ozon-a',
      accountIncarnation: '2026-07-21T00:00:00.000Z',
      platformName: 'Ozon',
    });
    assert.equal(profile.platformKey, 'ozon');
    assert.equal(profile.platformName, 'Ozon');
    assert.equal(profile.timezone, 'Europe/Moscow');
    assert.equal(profile.acceptLanguage, 'zh-CN,zh;q=0.9,ru;q=0.8,en;q=0.6');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Ozon buyer purchase profiles never share the seller integration environment identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-ozon-buyer-profile-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/149.0.0.0 Safari/537.36',
    });
    const buyer = store.getOrCreate({
      accountId: 'purchase-ozon-buyer-a',
      accountIncarnation: '2026-07-23T00:00:00.000Z',
      platformName: 'Ozon买家',
    });
    const seller = store.getOrCreate({
      accountId: 'integration-ozon-seller-a',
      accountIncarnation: '2026-07-23T00:00:00.000Z',
      platformName: 'Ozon',
    });
    assert.equal(buyer.platformKey, 'ozon-buyer');
    assert.equal(buyer.platformName, 'Ozon买家');
    assert.equal(buyer.locale, 'ru-RU');
    assert.equal(seller.platformKey, 'ozon');
    assert.notEqual(buyer.ownerRef, seller.ownerRef);
    assert.notEqual(buyer.fingerprint.seed, seller.fingerprint.seed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every purchase marketplace receives a stable named platform profile instead of unknown', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'purchase-browser-all-platforms-'));
  try {
    const store = createPurchaseBrowserProfileStore({
      filePath: path.join(directory, 'profiles.enc.json'),
      protector: reversibleTestProtector(),
      baseUserAgent: 'Mozilla/5.0 Test Chrome/149.0.0.0 Safari/537.36',
    });
    const expected = [
      ['拼多多', 'pinduoduo'], ['天猫', 'tmall'], ['淘宝', 'taobao'], ['1688', '1688'],
      ['Ozon买家', 'ozon-buyer'], ['京东', 'jd'], ['Wildberries', 'wildberries'],
      ['Amazon', 'amazon'], ['Temu', 'temu'], ['AliExpress', 'aliexpress'],
    ];
    const ownerRefs = new Set();
    expected.forEach(([platformName, platformKey], index) => {
      const profile = store.getOrCreate({
        accountId: `purchase-platform-${index + 1}`,
        accountIncarnation: '2026-08-11T00:00:00.000Z',
        platformName,
      });
      assert.equal(profile.platformKey, platformKey);
      assert.notEqual(profile.platformKey, 'unknown');
      ownerRefs.add(profile.ownerRef);
    });
    assert.equal(ownerRefs.size, expected.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
