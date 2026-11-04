import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLicenseManifestSha256 } from '../src/licensing/licenseConfig.js';
import { loadUiUpdateConfig } from '../src/updates/uiUpdateConfig.js';
import {
  isProtectedComputeTestFixtureCampaign,
  isProtectedComputeTestFixtureHostname,
  loadProtectedComputeDistribution,
  PROTECTED_COMPUTE_RESOURCE_PATHS,
} from '../src/licensing/protectedComputeDistribution.js';
import { scanProtectedComputePackagingBoundary } from '../../local-api/src/domain/protectedCompute/packageBoundaryAudit.js';
import { scanProtectedComputeSemanticBoundary } from './protected-compute-semantic-audit.mjs';
import {
  createAsarPackageReader,
  PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES,
  verifyProfileCacheMaintenanceAsarWiring,
} from './profile-cache-maintenance-package-proof.mjs';
import { currentPackageOutputRoot } from './current-version-identity.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), '..');
const managementSystemRoot = process.env.LICENSE_CENTER_ROOT
  ? path.resolve(process.env.LICENSE_CENTER_ROOT)
  : path.resolve(desktopRoot, '..', '..', '管理系统');
const packageConfigArgument = process.argv.find(argument => argument.startsWith('--package-config='));
const packageConfigPath = packageConfigArgument ? path.resolve(packageConfigArgument.slice('--package-config='.length)) : path.join(desktopRoot, 'package.json');
const packageConfig = JSON.parse(await fs.readFile(packageConfigPath, 'utf8'));
const unpackedRootArgument = process.argv.find((argument) => argument.startsWith('--unpacked-root='));
const unpackedRoot = unpackedRootArgument
  ? path.resolve(unpackedRootArgument.slice('--unpacked-root='.length))
  : path.join(currentPackageOutputRoot(), 'win-unpacked');
const resourcesRoot = path.join(unpackedRoot, 'resources');
const packagedCefHostRoot = path.join(unpackedRoot, 'cef-browser-host');
const packagedCefHostExecutable = path.join(packagedCefHostRoot, 'Wangzai.CefBrowserHost.exe');
const appAsarPath = path.join(resourcesRoot, 'app.asar');
const packagedOssAdapterPath = path.join(resourcesRoot, 'local-api', 'src', 'domain', 'productImages', 'aliyunOssProductImageStorage.js');
const packagedAliOssPackagePath = path.join(resourcesRoot, 'local-api', 'node_modules', 'ali-oss', 'package.json');
const executableName = packageConfig.build?.win?.executableName || packageConfig.build?.productName;

const requiredPaths = [
  path.join(unpackedRoot, `${executableName}.exe`),
  path.join(unpackedRoot, 'chrome_100_percent.pak'),
  path.join(unpackedRoot, 'icudtl.dat'),
  path.join(unpackedRoot, 'resources.pak'),
  path.join(unpackedRoot, 'v8_context_snapshot.bin'),
  packagedCefHostExecutable,
  path.join(packagedCefHostRoot, 'Wangzai.CefBrowserHost.dll'),
  path.join(packagedCefHostRoot, 'Wangzai.CefBrowserHost.runtimeconfig.json'),
  path.join(packagedCefHostRoot, 'CefSharp.BrowserSubprocess.exe'),
  path.join(packagedCefHostRoot, 'CefSharp.BrowserSubprocess.dll'),
  path.join(packagedCefHostRoot, 'libcef.dll'),
  path.join(packagedCefHostRoot, 'CefSharp.Core.Runtime.dll'),
  path.join(packagedCefHostRoot, 'resources.pak'),
  path.join(resourcesRoot, 'app.asar'),
  path.join(resourcesRoot, 'frontend-dist', 'index.html'),
  path.join(resourcesRoot, 'local-api', 'package.json'),
  path.join(resourcesRoot, 'shared', 'profitCoreWire.js'),
  path.join(resourcesRoot, 'local-api', 'config', 'local-api.config.json'),
  path.join(resourcesRoot, 'local-api', 'src', 'server.js'),
  packagedOssAdapterPath,
  packagedAliOssPackagePath,
  path.join(resourcesRoot, 'local-api', 'src', 'db', 'migrations', '001_create_base_tables.sql'),
  path.join(resourcesRoot, 'local-api', 'src', 'db', 'migrations', '063_repair_product_fact_provenance.sql'),
  path.join(resourcesRoot, 'local-api', 'src', 'domain', 'protectedCompute', 'protectedComputeService.js'),
  path.join(resourcesRoot, 'local-api', 'src', 'app', 'protectedComputeRoute.js'),
  path.join(resourcesRoot, 'local-api', 'src', 'maintenance', 'profileMaintenanceCommandService.js'),
  path.join(resourcesRoot, 'local-api', 'src', 'app', 'profileMaintenanceRoute.js'),
  path.join(resourcesRoot, 'local-api', 'src', 'data', 'unifiedDataResourceRegistry.js'),
  path.join(resourcesRoot, 'local-api', 'assets', 'ozonCategoryTree.zh.json'),
  path.join(resourcesRoot, 'bridge', 'purchase-search-bridge.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'auth.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'config.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'image-proxy.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'plugin-store.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'search-parsers.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'search-service.mjs'),
  path.join(resourcesRoot, 'bridge', 'purchase-bridge', 'search-utils.mjs'),
  path.join(resourcesRoot, 'tray', 'icon.png'),
  path.join(resourcesRoot, 'preload', 'preload.cjs'),
  path.join(resourcesRoot, 'license', 'project.json'),
  path.join(resourcesRoot, 'license', 'distribution.json'),
  path.join(
    resourcesRoot,
    'license',
    ...PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig.split('/'),
  ),
  path.join(
    resourcesRoot,
    'license',
    ...PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey.split('/'),
  ),
];

const missing = [];
const configurationErrors = [];
const missingAsarEntries = [];
const forbiddenFrontendArtifacts = [];
const forbiddenTestArtifacts = [];
let protectedComputeBoundary = null;
let protectedComputeSemanticBoundary = null;

if (packageConfig.main !== 'src/bootstrap.cjs') {
  configurationErrors.push('Electron 入口必须先经过同步协议 bootstrap：src/bootstrap.cjs');
}

try {
  const retiredPlugin = await fs.stat(path.join(resourcesRoot, 'purchase-capture-extension'));
  if (retiredPlugin.isDirectory()) configurationErrors.push('安装包仍包含旧 Electron/Chromium 拍单插件目录');
} catch {
  // 旧插件目录不存在才是目标状态。
}

function isTestArtifactPath(file) {
  return /(?:^|[\\/])(?:__tests__|test|tests|fixture|fixtures)(?:[\\/]|$)|\.(?:test|spec)\.[^.\\/]+$/iu.test(
    file,
  );
}
for (const filePath of requiredPaths) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) missing.push(filePath);
  } catch {
    missing.push(filePath);
  }
}

try {
  const packagedRequire = createRequire(packagedOssAdapterPath);
  const resolvedAliOss = path.resolve(packagedRequire.resolve('ali-oss'));
  const expectedDependencyRoot = `${path.resolve(resourcesRoot, 'local-api', 'node_modules')}${path.sep}`;
  if (!resolvedAliOss.startsWith(expectedDependencyRoot)) {
    configurationErrors.push(`打包后 ali-oss 解析到了安装包外部：${resolvedAliOss}`);
  }
  packagedRequire('ali-oss');
} catch (error) {
  configurationErrors.push(`打包后 local-api 无法加载 ali-oss：${error?.message || error}`);
}

const requiredAsarEntries = [...new Set([
  '/src/bootstrap.cjs',
  '/src/main.js',
  '/src/preload.cjs',
  '/src/runtime/desktopIpc.js',
  '/src/runtime/runtimeLifecycleController.js',
  '/src/runtime/serviceRuntime.js',
  '/src/licensing/licenseConfig.js',
  '/src/licensing/protectedComputeDistribution.js',
  '/src/purchaseBrowser/cefPurchaseBrowserController.js',
  '/src/purchaseBrowser/cefBrowserRuntime.js',
  '/src/purchaseBrowser/purchaseBrowserBuiltinManager.js',
  '/src/purchaseBrowser/purchaseBrowserProfileStore.js',
  ...PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES,
])];
const forbiddenRetiredPurchaseBrowserAsarEntries = [
  '/src/purchaseBrowser/purchaseBrowserController.js',
  '/src/purchaseBrowser/purchaseBrowserExtensionManager.js',
  '/src/purchaseBrowser/camoufoxPurchaseBrowserController.js',
  '/src/purchaseBrowser/camoufoxRuntime.js',
  '/src/purchaseBrowser/camoufox_sidecar.py',
  '/src/purchaseBrowser/purchaseBrowserHostWindow.js',
  '/src/purchaseBrowser/purchaseBrowserShellPreload.cjs',
];
let appAsarReader = null;
try {
  appAsarReader = createAsarPackageReader(appAsarPath);
  const packagedMetadata = JSON.parse(appAsarReader.readText('/package.json'));
  for (const field of ['name', 'version', 'main']) {
    if (packagedMetadata[field] !== packageConfig[field]) configurationErrors.push(`包内 ${field} 与所验收的构建配置不一致`);
  }
  const mainSource = appAsarReader.readText('/src/main.js');
  if (packageConfig.build?.appId && !mainSource.includes(`const APP_ID = ${JSON.stringify(packageConfig.build.appId)};`)) {
    configurationErrors.push('包内主进程 APP_ID 与安装产品标识不一致');
  }
  const packageEntries = [...appAsarReader.entries];
  const entries = appAsarReader.entries;
  for (const entry of requiredAsarEntries) {
    if (!entries.has(entry)) missingAsarEntries.push(entry);
  }
  for (const entry of forbiddenRetiredPurchaseBrowserAsarEntries) {
    if (entries.has(entry)) configurationErrors.push(`安装包仍包含旧 Electron 拍单链路：${entry}`);
  }
  for (const entry of packageEntries) {
    if (isTestArtifactPath(entry)) forbiddenTestArtifacts.push(`app.asar:${entry}`);
  }
} catch {
  missingAsarEntries.push(...requiredAsarEntries);
}

if (appAsarReader) {
  const bootstrapSource = appAsarReader.readText('/src/bootstrap.cjs');
  const schemeRegistrationOffset = bootstrapSource.indexOf('protocol.registerSchemesAsPrivileged');
  const mainImportOffset = bootstrapSource.indexOf("import('./main.js')");
  if (
    schemeRegistrationOffset < 0
    || mainImportOffset < 0
    || schemeRegistrationOffset > mainImportOffset
  ) {
    configurationErrors.push('安装包未在加载 ESM main 前同步注册 app:// 特权协议');
  }
  const maintenanceProof = verifyProfileCacheMaintenanceAsarWiring(appAsarReader);
  for (const finding of maintenanceProof.findings) {
    configurationErrors.push(
      `安装包普通清缓存入口证明失败：${finding.code}:${finding.entry}:${finding.evidence}`,
    );
  }
}

async function collectForbiddenTestFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectForbiddenTestFiles(target);
    else if (entry.isFile() && isTestArtifactPath(target)) {
      forbiddenTestArtifacts.push(target);
    }
  }
}
await collectForbiddenTestFiles(resourcesRoot);
await collectForbiddenTestFiles(packagedCefHostRoot);
try {
  const cefHostFiles = await fs.readdir(packagedCefHostRoot, { withFileTypes: true });
  const runtimeDebris = cefHostFiles
    .filter((entry) => entry.isFile() && /\.(?:log|dmp|tmp)$/iu.test(entry.name))
    .map((entry) => entry.name);
  if (runtimeDebris.length) {
    configurationErrors.push(`内置 CEF 宿主仍包含运行日志或临时文件：${runtimeDebris.join(', ')}`);
  }
} catch {
  // Missing host files are already reported by requiredPaths.
}

const indexPath = path.join(resourcesRoot, 'frontend-dist', 'index.html');
const missingFrontendAssets = [];
try {
  const html = await fs.readFile(indexPath, 'utf8');
  const references = Array.from(html.matchAll(/(?:src|href)="\/([^"?#]+)[^"]*"/gu), (match) => match[1]);
  for (const reference of references) {
    const assetPath = path.join(resourcesRoot, 'frontend-dist', ...reference.split('/'));
    try {
      const stat = await fs.stat(assetPath);
      if (!stat.isFile() || stat.size === 0) missingFrontendAssets.push(assetPath);
    } catch {
      missingFrontendAssets.push(assetPath);
    }
  }
} catch {
  // index.html 已经包含在 requiredPaths 的缺失报告中。
}

let frontendAssets = [];
try {
  const frontendRoot = path.join(resourcesRoot, 'frontend-dist');
  frontendAssets = await fs.readdir(path.join(frontendRoot, 'assets'));
  const candidateFiles = [
    path.join(frontendRoot, 'index.html'),
    ...frontendAssets
      .filter((name) => /\.(?:css|js)$/iu.test(name))
      .map((name) => path.join(frontendRoot, 'assets', name)),
  ];
  for (const filePath of candidateFiles) {
    const name = path.basename(filePath);
    const source = await fs.readFile(filePath, 'utf8');
    if (/PurchaseBrowserPage|内置拍单浏览器/iu.test(name) || /PurchaseBrowserPage|内置拍单浏览器/iu.test(source)) {
      forbiddenFrontendArtifacts.push(filePath);
    }
  }
} catch {
  // 缺少前端目录或资源时由 requiredPaths/missingFrontendAssets 统一报告。
}

try {
  const licenseRoot = path.join(resourcesRoot, 'license');
  const projectPath = path.join(licenseRoot, 'project.json');
  const distributionPath = path.join(licenseRoot, 'distribution.json');
  const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
  const distribution = JSON.parse(await fs.readFile(distributionPath, 'utf8'));
  loadUiUpdateConfig({ value: distribution.ui_update, licenseRoot, serverUrl: distribution.license_center_url, allowReadme: false });
  if (distribution.project_code !== project.code) configurationErrors.push('项目代码不一致');
  if (distribution.license_mode !== 'enforce') configurationErrors.push('正式安装包必须使用 enforce 模式');
  if (distribution.license_mode === 'enforce' && !/^[a-f0-9]{64}$/u.test(distribution.offline_key_sha256 || '')) {
    configurationErrors.push('enforce 安装包缺少离线公钥 SHA-256 指纹');
  }
  if (Boolean(distribution.channel_code) !== Boolean(distribution.distribution_token)) {
    configurationErrors.push('渠道代码和分发 Token 必须同时存在或同时留空');
  }
  try {
    const licenseCenterUrl = new URL(distribution.license_center_url);
    if (licenseCenterUrl.protocol !== 'https:') {
      configurationErrors.push('正式安装包的 License Center 必须使用 HTTPS');
    }
    if (isProtectedComputeTestFixtureHostname(licenseCenterUrl.hostname)) {
      configurationErrors.push(
        '正式安装包的 License Center 不能使用占位、文档保留、临时隧道、localhost 或 loopback 主机',
      );
    }
  } catch {
    configurationErrors.push('正式安装包的 License Center URL 无法解析');
  }
  if (isProtectedComputeTestFixtureCampaign(distribution.campaign_code)) {
    configurationErrors.push('正式安装包不能使用 test/fixture 活动代码');
  }

  const protectedComputeDirectory = path.join(licenseRoot, 'protected-compute');
  const expectedProtectedComputeFiles = new Set([
    path.basename(PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey),
    path.basename(PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig),
  ]);
  const protectedComputeEntries = await fs.readdir(protectedComputeDirectory, {
    withFileTypes: true,
  });
  if (
    protectedComputeEntries.length !== expectedProtectedComputeFiles.size
    || protectedComputeEntries.some(
      (entry) => (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !expectedProtectedComputeFiles.has(entry.name)
      ),
    )
  ) {
    configurationErrors.push('安装包受保护计算资源目录不是固定的 public-only 文件集合');
  }
  loadProtectedComputeDistribution({
    distribution,
    licenseRoot,
    expectedServerUrl: distribution.license_center_url,
    required: true,
    minimumRemainingMs: 24 * 60 * 60 * 1000,
  });

  if (!appAsarReader) throw new Error('app.asar reader is unavailable');
  const sealedSource = appAsarReader.readText('/src/licensing/sealedLicenseManifest.js');
  const sealedDigests = [...sealedSource.matchAll(
    /SEALED_LICENSE_MANIFEST_SHA256(?:_[A-Z0-9]+)?\s*=\s*["']([a-f0-9]{64})["']/gu,
  )].map((match) => match[1]);
  const expectedDigest = computeLicenseManifestSha256(projectPath, distributionPath);
  if (!sealedDigests.includes(expectedDigest)) {
    configurationErrors.push('安装包内 License 配置摘要与实际渠道配置不一致');
  }
} catch (error) {
  configurationErrors.push(`License 项目、渠道或受保护计算配置无法解析：${String(error?.message || error)}`);
}

try {
  const [hostStat, managedHostStat, subprocessStat, libcefStat] = await Promise.all([
    fs.stat(packagedCefHostExecutable),
    fs.stat(path.join(packagedCefHostRoot, 'Wangzai.CefBrowserHost.dll')),
    fs.stat(path.join(packagedCefHostRoot, 'CefSharp.BrowserSubprocess.exe')),
    fs.stat(path.join(packagedCefHostRoot, 'libcef.dll')),
  ]);
  if (
    !hostStat.isFile() || hostStat.size < 64 * 1024
    || !managedHostStat.isFile() || managedHostStat.size < 64 * 1024
    || !subprocessStat.isFile() || subprocessStat.size < 64 * 1024
    || !libcefStat.isFile() || libcefStat.size < 100 * 1024 * 1024
  ) {
    configurationErrors.push('内置 CEF 宿主文件无效或过小');
  }
} catch (error) {
  configurationErrors.push(`内置 CEF 宿主校验失败：${String(error?.code || error?.message || error)}`);
}

// Compare the packaged migration set with the source migration set rather than
// checking only the first migration.  A package that starts successfully on a
// developer machine but omits a newly added migration will otherwise create an
// incomplete database on a new customer device.
try {
  const sourceMigrationRoot = path.resolve(desktopRoot, '..', 'local-api', 'src', 'db', 'migrations');
  const packagedMigrationRoot = path.join(resourcesRoot, 'local-api', 'src', 'db', 'migrations');
  const sourceMigrations = (await fs.readdir(sourceMigrationRoot))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  const packagedMigrations = new Set(
    (await fs.readdir(packagedMigrationRoot)).filter((name) => /^\d+_.+\.sql$/u.test(name)),
  );
  for (const migration of sourceMigrations) {
    if (!packagedMigrations.has(migration)) {
      configurationErrors.push(`安装包缺少数据库迁移：${migration}`);
      continue;
    }
    const packagedPath = path.join(packagedMigrationRoot, migration);
    const packagedStat = await fs.stat(packagedPath);
    if (!packagedStat.isFile() || packagedStat.size === 0) {
      configurationErrors.push(`安装包数据库迁移为空：${migration}`);
    }
  }
} catch (error) {
  configurationErrors.push(`安装包数据库迁移集合无法核对：${String(error?.message || error)}`);
}

// The protected-compute server core, private signing keys and long-lived
// tokens and an equivalent implementation of a server-only algorithm are
// never client resources. Scan the actual unpacked artifacts (including source
// maps and each JavaScript ASAR entry), not only source directories.
try {
  const protectedClientRoots = [resourcesRoot];
  const protectedSemanticRoots = [];
  for (const entry of await fs.readdir(resourcesRoot, { withFileTypes: true })) {
    const target = path.join(resourcesRoot, entry.name);
    if (entry.name !== 'local-api' || !entry.isDirectory()) {
      protectedSemanticRoots.push(target);
      continue;
    }
    for (const localApiEntry of await fs.readdir(target, { withFileTypes: true })) {
      if (localApiEntry.name === 'node_modules') continue;
      protectedSemanticRoots.push(path.join(target, localApiEntry.name));
    }
  }
  [protectedComputeBoundary, protectedComputeSemanticBoundary] = await Promise.all([
    scanProtectedComputePackagingBoundary({
      clientRoots: protectedClientRoots,
      includeIgnoredDirectories: true,
      serverCoreRoot: path.join(
        managementSystemRoot,
        'backend',
        'app',
        'protected_compute',
        'core',
      ),
    }),
    scanProtectedComputeSemanticBoundary({
      // Third-party runtime dependencies are still scanned by the marker/key
      // boundary above. They are excluded only from the dynamic-code semantic
      // policy because libraries such as ali-oss legitimately ship bind/eval
      // compatibility code outside our protected business implementation.
      clientRoots: protectedSemanticRoots,
      packageMode: true,
      excludeTestFixtures: false,
    }),
  ]);
  if (!protectedComputeBoundary.ok) {
    configurationErrors.push(
      `安装包受保护计算边界扫描失败：${protectedComputeBoundary.findings
        .map((finding) => `${finding.code}:${finding.file}`)
      .join(', ')}`,
    );
  }
  if (!protectedComputeSemanticBoundary.ok) {
    configurationErrors.push(
      `安装包受保护计算等价公式扫描失败：${protectedComputeSemanticBoundary.findings
        .map((finding) => `${finding.code}:${finding.file}`)
        .join(', ')}`,
    );
  }
} catch (error) {
  configurationErrors.push(`安装包受保护计算边界无法核对：${String(error?.message || error)}`);
}

if (
  missing.length
  || missingFrontendAssets.length
  || missingAsarEntries.length
  || forbiddenFrontendArtifacts.length
  || forbiddenTestArtifacts.length
  || configurationErrors.length
) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        missing,
        missingFrontendAssets,
        missingAsarEntries,
        forbiddenFrontendArtifacts,
        forbiddenTestArtifacts,
        configurationErrors,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      executable: path.join(unpackedRoot, `${executableName}.exe`),
      requiredFiles: requiredPaths.length,
      requiredAsarEntries: requiredAsarEntries.length,
      frontendAssets: frontendAssets.length,
      protectedComputeScannedFiles: protectedComputeBoundary?.scannedFileCount || 0,
      protectedComputeSemanticScannedUnits: protectedComputeSemanticBoundary?.scannedUnitCount || 0,
      protectedComputeSemanticDeduplicatedUnits: protectedComputeSemanticBoundary?.duplicateUnitCount || 0,
      protectedComputeSemanticPrefilteredUnits: protectedComputeSemanticBoundary?.prefilteredUnitCount || 0,
    },
    null,
    2,
  ),
);
