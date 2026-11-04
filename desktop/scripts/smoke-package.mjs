import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  PROFILE_CACHE_MAINTENANCE_SMOKE_ARGUMENT,
  PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT,
  profileCacheMaintenanceSmokePaths,
} from '../src/runtime/profileCacheMaintenanceSmokeHarness.js';
import { PROFILE_CACHE_MAINTENANCE_ARGUMENT } from '../src/runtime/profileCacheMaintenanceLauncher.js';
import {
  assertPackagedSharedCatalogUnchanged,
  verifyPackagedSharedCatalog,
} from './shared-catalog-package-smoke-proof.mjs';
import {
  captureConcurrentShortcutChanges,
  captureInstallerShellShortcuts,
  captureInstallerShortcutOutputs,
  restoreInstallerShellShortcuts,
} from './installer-shell-shortcut-snapshot.mjs';
import { currentPackageOutputRoot } from './current-version-identity.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), '..');
const packageConfigArgument = process.argv.find(argument => argument.startsWith('--package-config='));
const packageConfigPath = packageConfigArgument ? path.resolve(packageConfigArgument.slice('--package-config='.length)) : path.join(desktopRoot, 'package.json');
const packageConfig = JSON.parse(await fs.readFile(packageConfigPath, 'utf8'));
const executableName = packageConfig.build?.win?.executableName || packageConfig.build?.productName;
const artifactProductName = packageConfig.build?.productName || executableName;
const artifactVersion = String(packageConfig.version || '').trim();
const distRootArgument = process.argv.find(argument => argument.startsWith('--dist-root='));
const distRoot = distRootArgument ? path.resolve(distRootArgument.slice('--dist-root='.length)) : currentPackageOutputRoot();
const keepFixtures = process.argv.includes('--keep-fixtures');
const reportArgument = process.argv.find(argument => argument.startsWith('--report='));
const reportPath = reportArgument ? path.resolve(reportArgument.slice('--report='.length)) : null;
const usePortableArtifact = process.argv.includes('--portable');
const useInstallerArtifact = process.argv.includes('--installer');
const selfTestProductFacts = process.argv.includes('--self-test-product-facts');
if (usePortableArtifact && useInstallerArtifact) {
  throw new Error('便携版与安装版烟测参数不能同时使用。');
}
const distEntries = usePortableArtifact || useInstallerArtifact ? await fs.readdir(distRoot) : [];
function selectReleaseArtifact(kind) {
  if (packageConfigArgument) {
    const template = kind === '安装版' ? packageConfig.build?.nsis?.artifactName : packageConfig.build?.portable?.artifactName;
    const name = String(template || '').replaceAll('${version}', artifactVersion).replaceAll('${arch}', 'x64')
      .replaceAll('${ext}', 'exe').replaceAll('${productName}', artifactProductName);
    if (path.basename(name) !== name || name.includes('${') || !name.endsWith('.exe') || !distEntries.includes(name)) throw new Error('显式候选配置的安装产物缺失或文件名无效');
    return name;
  }
  const prefix = `${artifactProductName}-${artifactVersion}-${kind}-`;
  const matches = distEntries.filter((name) => name.startsWith(prefix) && name.endsWith('.exe'));
  if (matches.length !== 1) {
    throw new Error(`发布包选择失败：${prefix}*.exe，匹配 ${matches.length} 个。`);
  }
  return matches[0];
}
const portableFileName = usePortableArtifact ? selectReleaseArtifact('便携版') : '';
const installerFileName = useInstallerArtifact ? selectReleaseArtifact('安装版') : '';
const artifactPath = useInstallerArtifact
  ? path.join(distRoot, installerFileName || '__missing_installer__.exe')
  : usePortableArtifact
  ? path.join(distRoot, portableFileName || '__missing_portable__.exe')
  : path.join(distRoot, 'win-unpacked', `${executableName}.exe`);
const runId = String(Date.now());
const runtimeRoot = path.join(desktopRoot, '.desktop-runtime-test', runId);
const installerRoot = path.join(desktopRoot, '.desktop-installer-test', runId);
const portableProfileCopyRoot = path.join(
  desktopRoot,
  '.desktop-runtime-test',
  `${runId}-portable-profile-copy`,
);
let executablePath = artifactPath;

await fs.mkdir(runtimeRoot, { recursive: true });

function getInstallerShellShortcutPaths() {
  return [
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'Desktop', `${artifactProductName}.lnk`)
      : '',
    process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
          `${artifactProductName}.lnk`,
        )
      : '',
  ].filter(Boolean);
}

function runProcess(file, args, { timeoutMs, label, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: path.dirname(file),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${label || file}超时。stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`));
    }, timeoutMs || 40_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function installForSmokeTest() {
  await fs.mkdir(installerRoot, { recursive: true });
  const result = await runProcess(artifactPath, ['/S', `/D=${installerRoot}`], {
    // The current installer contains Chromium, CEF and the OpenClaw runtime.
    // On a normal HDD/Windows Defender scan, extracting the many small runtime
    // files can legitimately take several minutes. Keep the smoke test bounded,
    // but do not tear down a healthy installer after the old two-minute limit.
    timeoutMs: 30 * 60_000,
    label: '桌面端安装版静默安装',
  });
  if (result.code !== 0) {
    throw new Error(`桌面端安装失败：exit=${result.code} signal=${result.signal || ''}\n${result.stderr.slice(-2000)}`);
  }
  const installedExecutable = path.join(installerRoot, `${executableName}.exe`);
  const installedStat = await fs.stat(installedExecutable).catch(() => null);
  if (!installedStat?.isFile() || installedStat.size === 0) {
    throw new Error(`安装版未生成主程序：${installedExecutable}`);
  }
  executablePath = installedExecutable;
}

function runSmokeTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--smoke-test'], {
      cwd: path.dirname(executablePath),
      env: {
        ...process.env,
        WANGZAI_DESKTOP_DATA_DIR: runtimeRoot,
        WANGZAI_PILOT_DATA_DIR: runtimeRoot,
        LOCAL_API_PORT: '4790',
        PURCHASE_SEARCH_BRIDGE_PORT: '4788',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // The packaged renderer's first app:// module is scheduled only after
      // Windows maps the Electron process. The BrowserWindow itself is an
      // almost-transparent, non-focusable smoke surface, so do not also apply
      // CREATE_NO_WINDOW here or the smoke test observes a false blank page.
      windowsHide: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Portable NSIS first extracts the complete Electron + CEF payload before
    // the app can start.  On a clean or antivirus-heavy machine that alone can
    // exceed the old 40-second smoke deadline, while the packaged runtime now
    // correctly allows up to 90 seconds for first-run SQLite migrations and
    // the 7,988-node catalog seed.  Keep the harness deadline outside both
    // budgets so a valid slow first launch is not reported as a package fault.
    const smokeTimeoutMs = usePortableArtifact ? 240_000 : 150_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`桌面端烟测超时。stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`));
    }, smokeTimeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function verifyFreshProfileDatabase() {
  const databasePath = path.join(runtimeRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get();
    if (quickCheck?.quick_check !== 'ok') {
      throw new Error(`新电脑数据库完整性校验失败：${quickCheck?.quick_check || 'unknown'}`);
    }
    const latestMigration = database.prepare(
      "SELECT version FROM schema_migrations WHERE version = '063_repair_product_fact_provenance'",
    ).get();
    if (!latestMigration) {
      throw new Error('新电脑数据库未执行到 063_repair_product_fact_provenance。');
    }
    const sharedCatalog = verifyPackagedSharedCatalog(database, {
      phase: '新 Profile 首启后',
    });
    return { databasePath, latestMigration: latestMigration.version, sharedCatalog };
  } finally {
    database.close();
  }
}

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const PRODUCT_FACT_FIXTURE = Object.freeze({
  identity: Object.freeze({
    productIdentityId: 'package-smoke-product-identity',
    shopId: 'package-smoke-shop',
    productId: '990000000063',
    offerId: 'package-smoke-canonical-offer',
    sku: 'PACKAGE-SMOKE-CANONICAL-001',
    source: 'ozon',
    operationId: 'package-smoke-products-list',
    contractVersion: 'products-list/v3',
    mapperVersion: 'package-smoke-product-fact-v1',
    responseHash: sha256Text('package-smoke-identity-response'),
    runId: 'package-smoke-run',
    snapshotId: 'package-smoke-snapshot',
    observedAt: '2026-07-16T00:00:00.000Z',
    sourceUpdatedAt: '2026-07-15T23:59:59.000Z',
    rowHash: sha256Text('package-smoke-identity-row'),
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  }),
  dimensions: Object.freeze({
    productIdentityId: 'package-smoke-product-identity',
    shopId: 'package-smoke-shop',
    sourceType: 'ozon',
    sourcePriority: 10,
    weightG: 638,
    lengthMm: 205,
    widthMm: 93,
    heightMm: 48,
    operationId: 'package-smoke-products-info-list',
    contractVersion: 'products-info-list/v3',
    mapperVersion: 'package-smoke-product-fact-v1',
    responseHash: sha256Text('package-smoke-dimensions-response'),
    runId: 'package-smoke-run',
    snapshotId: 'package-smoke-snapshot',
    observedAt: '2026-07-16T00:00:01.000Z',
    rowHash: sha256Text('package-smoke-dimensions-row'),
    updatedAt: '2026-07-16T00:00:01.000Z',
  }),
  commissions: Object.freeze([
    Object.freeze({
      fulfillmentType: 'FBO',
      ratePpm: null,
      status: 'unavailable',
      sourceReason: 'ozon-explicitly-unavailable',
    }),
    Object.freeze({
      fulfillmentType: 'FBS',
      ratePpm: 175000,
      status: 'returned',
      sourceReason: 'ozon-direct-commission',
    }),
    Object.freeze({
      fulfillmentType: 'RFBS',
      ratePpm: null,
      status: 'not_returned',
      sourceReason: 'ozon-contract-field-not-returned',
    }),
    Object.freeze({
      fulfillmentType: 'FBP',
      ratePpm: null,
      status: 'not_applicable',
      sourceReason: 'fulfillment-not-applicable',
    }),
  ].map((commission) => Object.freeze({
    productIdentityId: 'package-smoke-product-identity',
    shopId: 'package-smoke-shop',
    ...commission,
    operationId: 'package-smoke-products-prices',
    contractVersion: 'products-prices/v5',
    mapperVersion: 'package-smoke-product-fact-v1',
    responseHash: sha256Text(`package-smoke-commission-${commission.fulfillmentType}`),
    runId: 'package-smoke-run',
    snapshotId: 'package-smoke-snapshot',
    observedAt: '2026-07-16T00:00:02.000Z',
    rowHash: sha256Text(`package-smoke-commission-row-${commission.fulfillmentType}`),
    updatedAt: '2026-07-16T00:00:02.000Z',
  }))),
  facets: Object.freeze([
    Object.freeze({
      facet: 'dimensions',
      endpointKey: 'products.infoList',
      contractVersion: 'products-info-list/v3',
      responseHash: sha256Text('package-smoke-dimensions-response'),
      observedAt: '2026-07-16T00:00:01.000Z',
      sourceReason: 'ozon-dimensions-returned',
    }),
    Object.freeze({
      facet: 'commissions',
      endpointKey: 'products.prices',
      contractVersion: 'products-prices/v5',
      responseHash: sha256Text('package-smoke-commissions-facet-response'),
      observedAt: '2026-07-16T00:00:02.000Z',
      sourceReason: 'ozon-commission-facet-returned',
    }),
  ].map((facet) => Object.freeze({
    productIdentityId: 'package-smoke-product-identity',
    shopId: 'package-smoke-shop',
    ...facet,
    status: 'returned',
    operationId: `package-smoke-${facet.facet}`,
    mapperVersion: 'package-smoke-product-fact-v1',
    runId: 'package-smoke-run',
    snapshotId: 'package-smoke-snapshot',
    expectedAt: '2026-07-16T00:00:00.000Z',
    rowHash: sha256Text(`package-smoke-facet-row-${facet.facet}`),
    updatedAt: facet.observedAt,
  }))),
});

function readCanonicalProductFactFixture(database) {
  const productIdentityId = PRODUCT_FACT_FIXTURE.identity.productIdentityId;
  const identity = database.prepare(`
    SELECT
      product_identity_id AS productIdentityId,
      shop_id AS shopId,
      product_id AS productId,
      offer_id AS offerId,
      sku,
      source,
      operation_id AS operationId,
      contract_version AS contractVersion,
      mapper_version AS mapperVersion,
      response_hash AS responseHash,
      run_id AS runId,
      snapshot_id AS snapshotId,
      observed_at AS observedAt,
      source_updated_at AS sourceUpdatedAt,
      row_hash AS rowHash,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM product_identities
    WHERE product_identity_id = ?
  `).get(productIdentityId) || null;
  const dimensions = database.prepare(`
    SELECT
      product_identity_id AS productIdentityId,
      shop_id AS shopId,
      source_type AS sourceType,
      source_priority AS sourcePriority,
      weight_g AS weightG,
      length_mm AS lengthMm,
      width_mm AS widthMm,
      height_mm AS heightMm,
      operation_id AS operationId,
      contract_version AS contractVersion,
      mapper_version AS mapperVersion,
      response_hash AS responseHash,
      run_id AS runId,
      snapshot_id AS snapshotId,
      observed_at AS observedAt,
      row_hash AS rowHash,
      updated_at AS updatedAt
    FROM product_dimension_facts
    WHERE product_identity_id = ? AND source_type = 'ozon'
  `).get(productIdentityId) || null;
  const commissions = database.prepare(`
    SELECT
      product_identity_id AS productIdentityId,
      shop_id AS shopId,
      fulfillment_type AS fulfillmentType,
      rate_ppm AS ratePpm,
      status,
      source_reason AS sourceReason,
      operation_id AS operationId,
      contract_version AS contractVersion,
      mapper_version AS mapperVersion,
      response_hash AS responseHash,
      run_id AS runId,
      snapshot_id AS snapshotId,
      observed_at AS observedAt,
      row_hash AS rowHash,
      updated_at AS updatedAt
    FROM product_commission_facts
    WHERE product_identity_id = ?
    ORDER BY CASE fulfillment_type
      WHEN 'FBO' THEN 1 WHEN 'FBS' THEN 2 WHEN 'RFBS' THEN 3 ELSE 4 END
  `).all(productIdentityId);
  const facets = database.prepare(`
    SELECT
      product_identity_id AS productIdentityId,
      shop_id AS shopId,
      facet,
      endpoint_key AS endpointKey,
      contract_version AS contractVersion,
      response_hash AS responseHash,
      observed_at AS observedAt,
      source_reason AS sourceReason,
      status,
      operation_id AS operationId,
      mapper_version AS mapperVersion,
      run_id AS runId,
      snapshot_id AS snapshotId,
      expected_at AS expectedAt,
      row_hash AS rowHash,
      updated_at AS updatedAt
    FROM product_facet_observations
    WHERE product_identity_id = ? AND facet IN ('dimensions', 'commissions')
    ORDER BY CASE facet WHEN 'dimensions' THEN 1 ELSE 2 END
  `).all(productIdentityId);
  return { identity, dimensions, commissions, facets };
}

function assertCanonicalProductFactFixture(database, phase, { profileId }) {
  const actual = readCanonicalProductFactFixture(database);
  const expected = PRODUCT_FACT_FIXTURE;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${phase}商品 canonical facts 回读不一致：${JSON.stringify({ expected, actual })}`,
    );
  }
  const shop = database.prepare(`
    SELECT id, profile_id AS profileId, status, client_id AS clientId,
           external_identity_hash AS externalIdentityHash
    FROM shops WHERE id = ?
  `).get(PRODUCT_FACT_FIXTURE.identity.shopId);
  const expectedShop = {
    id: PRODUCT_FACT_FIXTURE.identity.shopId,
    profileId,
    status: 'inactive',
    clientId: null,
    externalIdentityHash: null,
  };
  if (JSON.stringify(shop) !== JSON.stringify(expectedShop)) {
    throw new Error(
      `${phase}商品 fixture 不属于当前 Profile：${JSON.stringify({ expectedShop, shop })}`,
    );
  }
  return {
    preserved: true,
    profileId,
    sku: actual.identity.sku,
    dimensions: {
      weightG: actual.dimensions.weightG,
      lengthMm: actual.dimensions.lengthMm,
      widthMm: actual.dimensions.widthMm,
      heightMm: actual.dimensions.heightMm,
    },
    commissions: actual.commissions.map(({ fulfillmentType, ratePpm, status, sourceReason }) => ({
      fulfillmentType,
      ratePpm,
      status,
      sourceReason,
    })),
    facets: actual.facets.map(({ facet, status, endpointKey }) => ({
      facet,
      status,
      endpointKey,
    })),
    sha256: sha256Text(JSON.stringify({ shop, facts: actual })),
  };
}

function insertCanonicalProductFactFixture(database, { profileId }) {
  if (!String(profileId || '').trim()) {
    throw new Error('商品 packaged smoke 缺少当前 profileId。');
  }
  const identity = PRODUCT_FACT_FIXTURE.identity;
  const dimensions = PRODUCT_FACT_FIXTURE.dimensions;
  database.prepare(`
    INSERT INTO shops (
      id, name, alias, client_id, api_key_encrypted, status,
      created_at, updated_at, profile_id, external_identity_hash,
      shop_incarnation, credential_revision, bound_at, disabled_at
    ) VALUES (?, ?, ?, NULL, NULL, 'inactive', ?, ?, ?, NULL, ?, 1, ?, NULL)
  `).run(
    identity.shopId,
    'Packaged cache maintenance smoke shop',
    'Package smoke',
    identity.createdAt,
    identity.updatedAt,
    profileId,
    'inc_package_smoke_20260716',
    identity.createdAt,
  );
  database.prepare(`
    INSERT INTO product_identities (
      product_identity_id, shop_id, product_id, offer_id, sku, source,
      operation_id, contract_version, mapper_version, response_hash,
      run_id, snapshot_id, observed_at, source_updated_at, row_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...Object.values(identity));
  database.prepare(`
    INSERT INTO product_dimension_facts (
      product_identity_id, shop_id, source_type, source_priority,
      weight_g, length_mm, width_mm, height_mm, operation_id,
      contract_version, mapper_version, response_hash, run_id, snapshot_id,
      observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...Object.values(dimensions));
  const insertCommission = database.prepare(`
    INSERT INTO product_commission_facts (
      product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
      source_reason, operation_id, contract_version, mapper_version,
      response_hash, run_id, snapshot_id, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  PRODUCT_FACT_FIXTURE.commissions.forEach((commission) => {
    insertCommission.run(...Object.values(commission));
  });
  const insertFacet = database.prepare(`
    INSERT INTO product_facet_observations (
      product_identity_id, shop_id, facet, endpoint_key, contract_version,
      response_hash, observed_at, source_reason, status, operation_id,
      mapper_version, run_id, snapshot_id, expected_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  PRODUCT_FACT_FIXTURE.facets.forEach((facet) => {
    insertFacet.run(...Object.values(facet));
  });
}

async function seedProfileCacheMaintenanceFixture() {
  const databasePath = path.join(runtimeRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const profile = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'profile.json'), 'utf8'));
  const profileId = String(profile?.profileId || '').trim();
  if (!profileId) throw new Error('新电脑 packaged smoke profile.json 缺少 profileId。');
  const protectedValue = JSON.stringify({
    source: 'packaged-cache-maintenance-smoke',
    nonce: randomBytes(12).toString('hex'),
  });
  const database = new DatabaseSync(databasePath);
  let productFacts;
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(namespace) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run('smoke.profile-cache.protected', protectedValue);
    database.prepare(`
      INSERT INTO ozon_response_cache (
        id, domain, shop_id, endpoint_key, cache_key, status, is_stale,
        payload_json, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 'confirmed', 0, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      'smoke-profile-cache-response',
      'package-smoke',
      'package-smoke.read',
      'package-smoke:transient',
      JSON.stringify({ transient: true }),
    );
    insertCanonicalProductFactFixture(database, { profileId });
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    productFacts = assertCanonicalProductFactFixture(database, '清缓存前', { profileId });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  } finally {
    database.close();
  }

  const token = randomBytes(32).toString('base64url');
  const smokePaths = profileCacheMaintenanceSmokePaths(runtimeRoot);
  await fs.mkdir(path.dirname(smokePaths.markerPath), { recursive: true });
  await fs.writeFile(
    smokePaths.markerPath,
    `${JSON.stringify({
      contract: PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT,
      databaseSha256: await sha256File(databasePath),
      tokenSha256: createHash('sha256').update(token).digest('hex'),
    })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return {
    databasePath,
    profileId,
    protectedValue,
    productFacts,
    smokePaths,
    token,
  };
}

async function runProfileCacheMaintenanceSmoke(fixture, sharedCatalogBaseline) {
  const result = await runProcess(
    executablePath,
    [
      '--smoke-test',
      PROFILE_CACHE_MAINTENANCE_ARGUMENT,
      PROFILE_CACHE_MAINTENANCE_SMOKE_ARGUMENT,
    ],
    {
      timeoutMs: 120_000,
      label: '安装包普通清缓存维护模式',
      env: {
        ...process.env,
        WANGZAI_DESKTOP_DATA_DIR: runtimeRoot,
        WANGZAI_PILOT_DATA_DIR: runtimeRoot,
        WANGZAI_PROFILE_CACHE_MAINTENANCE_SMOKE_TOKEN: fixture.token,
        LOCAL_API_PORT: '4790',
        PURCHASE_SEARCH_BRIDGE_PORT: '4788',
      },
    },
  );
  if (result.code !== 0) {
    const mainLog = await fs.readFile(path.join(runtimeRoot, 'logs', 'desktop-main.log'), 'utf8').catch(() => '');
    throw new Error(
      `普通清缓存维护 smoke 失败：exit=${result.code} signal=${result.signal || ''}\n${mainLog.slice(-4000)}\n${result.stderr.slice(-2000)}`,
    );
  }
  const maintenance = JSON.parse(await fs.readFile(fixture.smokePaths.resultPath, 'utf8'));
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  let databaseProof;
  try {
    const transientRows = Number(
      database.prepare("SELECT COUNT(*) AS count FROM ozon_response_cache WHERE id = 'smoke-profile-cache-response'").get()?.count,
    );
    const protectedRow = database.prepare(
      "SELECT value_json FROM profile_settings WHERE namespace = 'smoke.profile-cache.protected'",
    ).get();
    const productFacts = assertCanonicalProductFactFixture(database, '清缓存后', {
      profileId: fixture.profileId,
    });
    const sharedCatalog = verifyPackagedSharedCatalog(database, {
      phase: '普通清缓存后',
    });
    assertPackagedSharedCatalogUnchanged(sharedCatalogBaseline, sharedCatalog, {
      phase: '普通清缓存后',
    });
    const quickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check;
    databaseProof = {
      transientRows,
      protectedValuePreserved: protectedRow?.value_json === fixture.protectedValue,
      productFacts,
      sharedCatalog,
      quickCheck,
    };
  } finally {
    database.close();
  }
  const reportExists = maintenance.reportPath
    ? Boolean((await fs.stat(maintenance.reportPath).catch(() => null))?.isFile())
    : false;
  if (
    maintenance.ok !== true
    || maintenance.completed !== true
    || maintenance.restartRequired !== true
    || maintenance.continueStartup !== false
    || maintenance.maintenance?.protectedDatabaseDigestBefore
      !== maintenance.maintenance?.protectedDatabaseDigestAfter
    || maintenance.maintenance?.protectedDigestBefore
      !== maintenance.maintenance?.protectedDigestAfter
    || databaseProof.transientRows !== 0
    || !databaseProof.protectedValuePreserved
    || !databaseProof.productFacts?.preserved
    || databaseProof.productFacts.sha256 !== fixture.productFacts.sha256
    || databaseProof.sharedCatalog?.retainedFingerprint
      !== sharedCatalogBaseline?.retainedFingerprint
    || databaseProof.quickCheck !== 'ok'
    || !reportExists
  ) {
    throw new Error(
      `普通清缓存维护 smoke 回读不一致：${JSON.stringify({ maintenance, databaseProof, reportExists })}`,
    );
  }
  return {
    completed: true,
    protectedDatabaseDigest: maintenance.maintenance.protectedDatabaseDigestAfter,
    protectedFileDigest: maintenance.maintenance.protectedDigestAfter,
    reportExists,
    databaseProof,
  };
}

function verifyProtectedFixtureAfterRestart(fixture, sharedCatalogBaseline = null) {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT value_json FROM profile_settings WHERE namespace = 'smoke.profile-cache.protected'",
    ).get();
    if (row?.value_json !== fixture.protectedValue) {
      throw new Error('普通清缓存后的正常重启没有读回受保护 profile setting。');
    }
    const productFacts = assertCanonicalProductFactFixture(database, '清缓存后正常重启', {
      profileId: fixture.profileId,
    });
    if (productFacts.sha256 !== fixture.productFacts.sha256) {
      throw new Error('普通清缓存后的正常重启商品 facts 指纹不一致。');
    }
    const sharedCatalog = verifyPackagedSharedCatalog(database, {
      phase: '普通清缓存后正常重启',
    });
    if (sharedCatalogBaseline) {
      assertPackagedSharedCatalogUnchanged(sharedCatalogBaseline, sharedCatalog, {
        phase: '普通清缓存后正常重启',
      });
    }
    return {
      protectedValuePreservedAfterRestart: true,
      productFactsPreservedAfterRestart: true,
      productFacts,
      sharedCatalog,
    };
  } finally {
    database.close();
  }
}

function deleteSmokeShopAndVerifySharedCatalog(fixture, sharedCatalogBaseline) {
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('BEGIN IMMEDIATE');
    const deletion = database.prepare('DELETE FROM shops WHERE id = ?').run(
      PRODUCT_FACT_FIXTURE.identity.shopId,
    );
    if (Number(deletion.changes) !== 1) {
      throw new Error(`删除烟测测试店数量异常：${Number(deletion.changes)}`);
    }
    const remainingFacts = Number(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM product_identities WHERE shop_id = ?) +
        (SELECT COUNT(*) FROM product_dimension_facts WHERE shop_id = ?) +
        (SELECT COUNT(*) FROM product_commission_facts WHERE shop_id = ?) +
        (SELECT COUNT(*) FROM product_facet_observations WHERE shop_id = ?)
        AS count
    `).get(
      PRODUCT_FACT_FIXTURE.identity.shopId,
      PRODUCT_FACT_FIXTURE.identity.shopId,
      PRODUCT_FACT_FIXTURE.identity.shopId,
      PRODUCT_FACT_FIXTURE.identity.shopId,
    )?.count || 0);
    if (remainingFacts !== 0) {
      throw new Error(`删除烟测测试店后仍残留商品 facts：${remainingFacts}`);
    }
    const foreignKeyViolation = database.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyViolation) {
      throw new Error(`删除烟测测试店后出现外键异常：${JSON.stringify(foreignKeyViolation)}`);
    }
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const sharedCatalog = verifyPackagedSharedCatalog(database, {
      phase: '删除烟测测试店后',
    });
    assertPackagedSharedCatalogUnchanged(sharedCatalogBaseline, sharedCatalog, {
      phase: '删除烟测测试店后',
    });
    return {
      deletedShopId: PRODUCT_FACT_FIXTURE.identity.shopId,
      deletedRows: Number(deletion.changes),
      remainingProductFacts: remainingFacts,
      sharedCatalog,
    };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  } finally {
    database.close();
  }
}

function checkpointCanonicalDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check;
    if (quickCheck !== 'ok') {
      throw new Error(`portable profile 复制前 SQLite quick_check 失败：${quickCheck || 'unknown'}`);
    }
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
    if (Number(checkpoint.busy) > 0) {
      throw new Error('portable profile 复制前 SQLite WAL 仍被占用。');
    }
  } finally {
    database.close();
  }
}

async function replaceOwnedFileFromBackup(backupPath, destinationPath, label) {
  const temporaryPath = `${destinationPath}.portable-restore-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fs.copyFile(backupPath, temporaryPath);
    await fs.rm(destinationPath, { force: true });
    await fs.rename(temporaryPath, destinationPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const restored = await fs.stat(destinationPath).catch(() => null);
  if (!restored?.isFile() || restored.size < 1) {
    throw new Error(`${label} restore did not create a regular file`);
  }
}

async function runPortableProfileCopyRestoreRoundtrip(fixture) {
  const copyRoot = portableProfileCopyRoot;
  const sourceDatabase = fixture.databasePath;
  const sourceSecret = path.join(runtimeRoot, 'local-api-data', 'local-api-secret.key');
  const sourceProfile = path.join(runtimeRoot, 'profile.json');
  checkpointCanonicalDatabase(sourceDatabase);
  await fs.rm(copyRoot, { recursive: true, force: true });
  await fs.cp(runtimeRoot, copyRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  const copiedDatabase = path.join(copyRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const copiedSecret = path.join(copyRoot, 'local-api-data', 'local-api-secret.key');
  const copiedProfile = path.join(copyRoot, 'profile.json');
  const sourceHashes = {
    database: await sha256File(sourceDatabase),
    secret: await sha256File(sourceSecret),
    profile: await sha256File(sourceProfile),
  };
  const copiedHashes = {
    database: await sha256File(copiedDatabase),
    secret: await sha256File(copiedSecret),
    profile: await sha256File(copiedProfile),
  };
  if (JSON.stringify(sourceHashes) !== JSON.stringify(copiedHashes)) {
    throw new Error(`portable profile copy hashes diverged：${JSON.stringify({ sourceHashes, copiedHashes })}`);
  }

  const database = new DatabaseSync(sourceDatabase);
  try {
    database.prepare(`
      UPDATE profile_settings SET value_json = ?
      WHERE namespace = 'smoke.profile-cache.protected'
    `).run(JSON.stringify({ intentionallyTamperedForPortableRestore: true }));
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
  await fs.writeFile(sourceSecret, 'portable-restore-intentional-key-tamper', 'utf8');
  if (
    await sha256File(sourceDatabase) === sourceHashes.database
    || await sha256File(sourceSecret) === sourceHashes.secret
  ) {
    throw new Error('portable profile restore fixture did not change both canonical files');
  }

  await Promise.all([
    fs.rm(`${sourceDatabase}-wal`, { force: true }),
    fs.rm(`${sourceDatabase}-shm`, { force: true }),
  ]);
  await replaceOwnedFileFromBackup(copiedDatabase, sourceDatabase, 'portable SQLite');
  await replaceOwnedFileFromBackup(copiedSecret, sourceSecret, 'portable secret key');
  if (
    await sha256File(sourceDatabase) !== sourceHashes.database
    || await sha256File(sourceSecret) !== sourceHashes.secret
    || await sha256File(sourceProfile) !== sourceHashes.profile
  ) {
    throw new Error('portable profile restore hashes did not return to the copied profile state');
  }

  const restarted = await runSmokeTest();
  const mainLog = await fs.readFile(path.join(runtimeRoot, 'logs', 'desktop-main.log'), 'utf8').catch(() => '');
  if (restarted.code !== 0 || !mainLog.includes('[smoke] renderer-ready')) {
    throw new Error(`portable profile restore 后重启失败：exit=${restarted.code}\n${mainLog.slice(-4000)}`);
  }
  const readback = verifyProtectedFixtureAfterRestart(fixture);
  const restoredSecretSha256 = await sha256File(sourceSecret);
  const restoredProfileSha256 = await sha256File(sourceProfile);
  if (
    restoredSecretSha256 !== sourceHashes.secret
    || restoredProfileSha256 !== sourceHashes.profile
  ) {
    throw new Error('portable profile restore 后密钥或 profile metadata 指纹变化');
  }
  return {
    completed: true,
    fullProfileCopied: true,
    databaseRestoredBeforeRestart: true,
    secretKeyRestoredBeforeRestart: true,
    canonicalFactsReadBackAfterRestart: readback.productFactsPreservedAfterRestart,
    sourceHashes,
    copyRoot,
  };
}

async function createInstallerUninstallRetentionFixture(fixture) {
  const databasePath = fixture.databasePath;
  const secretPath = path.join(runtimeRoot, 'local-api-data', 'local-api-secret.key');
  const profilePath = path.join(runtimeRoot, 'profile.json');
  checkpointCanonicalDatabase(databasePath);
  const protectedHashes = {
    database: await sha256File(databasePath),
    secret: await sha256File(secretPath),
    profile: await sha256File(profilePath),
  };
  const sentinelPath = path.join(runtimeRoot, 'uninstall-retention-smoke.sentinel.json');
  await fs.writeFile(sentinelPath, `${JSON.stringify({
    contract: 'installer-uninstall-profile-retention/v1',
    profileId: fixture.profileId,
    protectedHashes,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return {
    databasePath,
    secretPath,
    profilePath,
    sentinelPath,
    protectedHashes,
    sentinelSha256: await sha256File(sentinelPath),
  };
}

async function uninstallAndVerifyProfileRetention(retentionFixture) {
  const entries = await fs.readdir(installerRoot);
  const uninstallers = entries.filter((name) => (
    /^unins.*\.exe$/iu.test(name)
    || /^uninstall\s.+\.exe$/iu.test(name)
  ));
  if (uninstallers.length !== 1) {
    throw new Error(`安装版必须产生一个明确卸载器，实际：${uninstallers.join(',') || 'none'}`);
  }
  const result = await runProcess(path.join(installerRoot, uninstallers[0]), ['/S'], {
    timeoutMs: 60_000,
    label: '桌面端安装版静默卸载',
  });
  if (result.code !== 0) {
    throw new Error(`桌面端安装版静默卸载失败：exit=${result.code} signal=${result.signal || ''}`);
  }
  if (!retentionFixture) {
    return { completed: true, profileRetentionChecked: false };
  }
  const [databaseHash, secretHash, profileHash, sentinelHash] = await Promise.all([
    sha256File(retentionFixture.databasePath),
    sha256File(retentionFixture.secretPath),
    sha256File(retentionFixture.profilePath),
    sha256File(retentionFixture.sentinelPath),
  ]);
  const after = { database: databaseHash, secret: secretHash, profile: profileHash };
  if (
    JSON.stringify(after) !== JSON.stringify(retentionFixture.protectedHashes)
    || sentinelHash !== retentionFixture.sentinelSha256
  ) {
    throw new Error(`安装版卸载修改了自定义 Profile：${JSON.stringify({ before: retentionFixture.protectedHashes, after })}`);
  }
  return {
    completed: true,
    uninstallerExitCode: result.code,
    profileRetentionChecked: true,
    canonicalDatabasePreserved: true,
    secretKeyPreserved: true,
    profileMetadataPreserved: true,
    sentinelPreserved: true,
    protectedHashes: after,
  };
}

if (selfTestProductFacts) {
  const databasePath = path.join(runtimeRoot, 'product-fact-self-test.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    const { runMigrations } = await import('../../local-api/src/db/database.js');
    runMigrations(database);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('BEGIN IMMEDIATE');
    const profileId = 'package-smoke-self-test-profile';
    insertCanonicalProductFactFixture(database, { profileId });
    database.exec('COMMIT');
    const productFacts = assertCanonicalProductFactFixture(database, 'self-test', { profileId });
    console.log(JSON.stringify({ ok: true, productFacts }, null, 2));
  } finally {
    database.close();
    await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
} else {
  let smokeReport = null;
  let installerRetentionFixture = null;
  let installerUninstall = null;
  let installerShellShortcutSnapshots = [];
  let portableProfileRestore = null;
  try {
    if (useInstallerArtifact) {
      installerShellShortcutSnapshots = await captureInstallerShellShortcuts(
        getInstallerShellShortcutPaths(),
      );
      await installForSmokeTest();
      await captureInstallerShortcutOutputs(installerShellShortcutSnapshots);
    }
    const result = await runSmokeTest();
    const mainLogPath = path.join(runtimeRoot, 'logs', 'desktop-main.log');
    const mainLog = await fs.readFile(mainLogPath, 'utf8').catch(() => '');
    if (result.code !== 0 || !mainLog.includes('[smoke] renderer-ready')) {
      throw new Error(
        `桌面端烟测失败：exit=${result.code} signal=${result.signal || ''}\n${mainLog.slice(-4000)}\n${result.stderr.slice(-2000)}`,
      );
    }
    const freshProfile = verifyFreshProfileDatabase();
    const sharedCatalogBaseline = freshProfile.sharedCatalog;
    const cacheFixture = await seedProfileCacheMaintenanceFixture();
    const cacheMaintenance = await runProfileCacheMaintenanceSmoke(
      cacheFixture,
      sharedCatalogBaseline,
    );
    const restarted = await runSmokeTest();
    const restartLog = await fs.readFile(mainLogPath, 'utf8').catch(() => '');
    if (restarted.code !== 0 || !restartLog.includes('[smoke] renderer-ready')) {
      throw new Error(`普通清缓存后正常重启失败：exit=${restarted.code}\n${restartLog.slice(-4000)}`);
    }
    const cacheRestartReadback = verifyProtectedFixtureAfterRestart(
      cacheFixture,
      sharedCatalogBaseline,
    );
    if (usePortableArtifact) {
      portableProfileRestore = await runPortableProfileCopyRestoreRoundtrip(cacheFixture);
    }
    const smokeShopDeletion = deleteSmokeShopAndVerifySharedCatalog(
      cacheFixture,
      sharedCatalogBaseline,
    );
    if (useInstallerArtifact) {
      installerRetentionFixture = await createInstallerUninstallRetentionFixture(cacheFixture);
    }
    smokeReport = {
      ok: true,
      mode: useInstallerArtifact ? 'installer' : usePortableArtifact ? 'portable' : 'unpacked',
      artifact: artifactPath,
      executable: executablePath,
      rendererReady: true,
      freshProfile,
      cacheMaintenance,
      cacheRestartReadback,
      smokeShopDeletion,
      portableProfileRestore,
    };
  } finally {
    if (useInstallerArtifact) {
      try {
        await captureConcurrentShortcutChanges(installerShellShortcutSnapshots);
        installerUninstall = await uninstallAndVerifyProfileRetention(
          installerRetentionFixture,
        );
        // The smoke installation root is always a timestamped child of the
        // workspace-owned directory above.  Remove only that verified child; an
        // NSIS uninstaller may intentionally leave an empty directory behind.
        const resolvedInstallerRoot = path.resolve(installerRoot);
        const resolvedOwnedRoot = `${path.resolve(desktopRoot, '.desktop-installer-test')}${path.sep}`;
        if (resolvedInstallerRoot.startsWith(resolvedOwnedRoot)) {
          await fs.rm(resolvedInstallerRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      } finally {
        await restoreInstallerShellShortcuts(installerShellShortcutSnapshots);
      }
    }
    if (!keepFixtures) {
      await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
      // Use the deterministic owned path rather than the report object.
      await fs.rm(portableProfileCopyRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (smokeReport) {
    const completedReport = {
      ...smokeReport,
      installerUninstall,
      ...(keepFixtures ? { retainedRuntimeFixture: runtimeRoot } : {}),
    };
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(completedReport, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(completedReport, null, 2));
  }
}
