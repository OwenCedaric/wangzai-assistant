import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { computeLicenseManifestSha256 } from '../src/licensing/licenseConfig.js';
import { loadProtectedComputeDistribution } from '../src/licensing/protectedComputeDistribution.js';
import { loadUiUpdateConfig } from '../src/updates/uiUpdateConfig.js';
import { createSignedUiUpdate } from './create-signed-ui-update.mjs';

const workspace = path.resolve(import.meta.dirname, '../..');
const desktop = path.join(workspace, 'desktop');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const PILOT_IDENTITY = Object.freeze({ appId: 'com.wangzai.assistant.desktop.pilot', name: 'wangzai-desktop-pilot', productName: '旺崽助手内测', dataDirectory: 'WangzaiAssistantPilot' });
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });

function securePrivateDirectory(directory) {
  if (process.platform !== 'win32') throw new Error('PILOT_WINDOWS_ACL_REQUIRED');
  fs.mkdirSync(directory);
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true });
  const sid = result.stdout?.trim();
  if (result.status !== 0 || !/^S-1-5-[0-9-]+$/u.test(sid)) throw new Error('PILOT_PRIVATE_OWNER_UNAVAILABLE');
  const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' });
  if (acl.status !== 0) throw new Error('PILOT_PRIVATE_ACL_FAILED');
}

export function pilotBootstrapSource({ delegate = true } = {}) {
  return `const { app } = require('electron');
const path = require('node:path');
app.setName(${JSON.stringify(PILOT_IDENTITY.productName)});
const pilotData = path.resolve(process.env.WANGZAI_PILOT_DATA_DIR || path.join(app.getPath('appData'), ${JSON.stringify(PILOT_IDENTITY.dataDirectory)}));
// Never inherit the normal/source edition's profile override.
process.env.WANGZAI_DESKTOP_DATA_DIR = pilotData;
app.setPath('userData', pilotData);
Object.assign(process.env, { LOCAL_API_PORT: '6890', PURCHASE_SEARCH_BRIDGE_PORT: '6888', WANGZAI_CACHE_AGENT_PORT: '6892', WANGZAI_OZON_PUSH_GATEWAY_PORT: '6894' });
${delegate ? "require('./src/bootstrap.cjs');" : ''}
`;
}

export function stagePrivatePilotInstaller({ assetsDirectory, outputDirectory, uiSigningPrivateKeyFile, version = '1.0.2-pilot.1' }) {
  if (!/^\d+\.\d+\.\d+-pilot\.\d+$/u.test(version)) throw new Error('PILOT_VERSION_INVALID');
  const assets = path.resolve(assetsDirectory), output = path.resolve(outputDirectory);
  const relative = path.relative(path.join(workspace, '.codex-temp'), output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(output)) throw new Error('PILOT_STAGE_MUST_BE_NEW_ISOLATED_DIRECTORY');
  const candidate = JSON.parse(fs.readFileSync(path.join(assets, 'candidate-manifest.json'), 'utf8'));
  if (candidate.contract !== 'wangzai-private-profit-pilot-assets/v1' || candidate.assetBuildComplete !== true || candidate.audit?.ok !== true) throw new Error('PILOT_ASSET_PROOF_MISSING');
  for (const file of candidate.client.files) {
    const resolved = path.resolve(assets, 'client', file.path);
    if (!resolved.startsWith(path.join(assets, 'client') + path.sep) || hash(fs.readFileSync(resolved)) !== file.sha256) throw new Error('PILOT_CLIENT_ASSET_CHANGED');
  }
  const coreFile = path.join(assets, 'server', 'profit-core.mjs');
  if (hash(fs.readFileSync(coreFile)) !== candidate.server.codeSha256) throw new Error('PILOT_SERVER_CORE_CHANGED');
  const distribution = JSON.parse(fs.readFileSync(path.join(desktop, 'resources/distribution.json'), 'utf8'));
  loadProtectedComputeDistribution({ distribution, licenseRoot: path.join(desktop, 'resources'), expectedServerUrl: distribution.license_center_url, required: true, minimumRemainingMs: 86400000 });
  if (distribution.license_mode !== 'enforce' || Boolean(distribution.thin_client?.enabled ?? distribution.thin_client)) throw new Error('PILOT_REQUIRES_ENFORCED_LOCAL_DATA_MODE');
  fs.mkdirSync(output, { recursive: true });
  const appDirectory = path.join(output, 'desktop'), resources = path.join(appDirectory, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const privateDirectory = path.join(output, 'server-private');
  securePrivateDirectory(privateDirectory);
  const signingKey = uiSigningPrivateKeyFile ? createPrivateKey(fs.readFileSync(uiSigningPrivateKeyFile)) : generateKeyPairSync('ed25519').privateKey;
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('PILOT_UI_SIGNING_KEY_INVALID');
  const publicKey = createPublicKey(signingKey).export({ type: 'spki', format: 'pem' });
  const privateKey = signingKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(privateDirectory, 'ui-update-signing.pem'), privateKey, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(resources, 'ui-updates'));
  fs.writeFileSync(path.join(resources, 'ui-updates/public.pem'), publicKey, { flag: 'wx' });
  distribution.ui_update = { enabled: true, app_id: PILOT_IDENTITY.appId, channel: 'pilot', public_key_sha256: hash(publicKey), shell_api: 1 };
  fs.copyFileSync(path.join(desktop, 'resources/project.json'), path.join(resources, 'project.json'), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(resources, 'distribution.json'), distribution);
  fs.mkdirSync(path.join(resources, 'protected-compute'));
  for (const file of ['configuration-public.pem', 'protected-compute.signed-public.json']) fs.copyFileSync(path.join(desktop, 'resources/protected-compute', file), path.join(resources, 'protected-compute', file), fs.constants.COPYFILE_EXCL);
  loadUiUpdateConfig({ value: distribution.ui_update, licenseRoot: resources, serverUrl: distribution.license_center_url, allowReadme: false });
  fs.cpSync(path.join(desktop, 'src'), path.join(appDirectory, 'src'), { recursive: true,
    filter: file => !/(?:^|[\\/])(?:__tests__|test|tests|fixture|fixtures)(?:[\\/]|$)|\.(?:test|spec)\./iu.test(file),
  });
  const digest = computeLicenseManifestSha256(path.join(resources, 'project.json'), path.join(resources, 'distribution.json'));
  const sealedFile = path.join(appDirectory, 'src/licensing/sealedLicenseManifest.js');
  const source = fs.readFileSync(sealedFile, 'utf8');
  if (!/export const SEALED_LICENSE_MANIFEST_SHA256\s*=\s*['"][a-f0-9]{64}['"]/u.test(source)) throw new Error('PILOT_SEALED_MANIFEST_SHAPE_INVALID');
  fs.writeFileSync(sealedFile, source.replace(/(export const SEALED_LICENSE_MANIFEST_SHA256\s*=\s*)['"][a-f0-9]{64}['"]/u, `$1${JSON.stringify(digest)}`));
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const originalBuild = pkg.build;
  pkg.name = PILOT_IDENTITY.name; pkg.productName = PILOT_IDENTITY.productName; pkg.main = 'src/bootstrap.cjs'; pkg.scripts = {};
  pkg.version = version;
  const stagedResourceTargets = new Set(['license/project.json', 'license/distribution.json', 'license/protected-compute', 'license/ui-updates']);
  pkg.build = { ...originalBuild, appId: PILOT_IDENTITY.appId, productName: PILOT_IDENTITY.productName,
    electronVersion: JSON.parse(fs.readFileSync(path.join(desktop, 'node_modules/electron/package.json'), 'utf8')).version,
    electronDist: path.join(desktop, 'node_modules/electron/dist'), npmRebuild: false,
    afterPack: path.join(desktop, 'scripts/pilot-after-pack.cjs'),
    directories: { buildResources: path.join(desktop, 'resources'), output: path.join(output, 'installer-output') },
    files: [...originalBuild.files, 'pilot-bootstrap.cjs'],
    extraResources: originalBuild.extraResources.map(entry => ({ ...entry, from: entry.to === 'frontend-dist' ? path.join(assets, 'client')
      : stagedResourceTargets.has(entry.to) ? path.resolve(appDirectory, entry.from) : path.resolve(desktop, entry.from) })),
    extraFiles: originalBuild.extraFiles.map(entry => ({ ...entry, from: path.resolve(desktop, entry.from) })),
    win: { ...originalBuild.win, icon: path.join(desktop, 'resources/icon.ico'), executableName: PILOT_IDENTITY.productName, target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: { ...originalBuild.nsis, shortcutName: PILOT_IDENTITY.productName, uninstallDisplayName: PILOT_IDENTITY.productName, artifactName: 'Wangzai-Pilot-${version}-x64.${ext}' },
  };
  writeJson(path.join(appDirectory, 'package.json'), pkg);
  const identity = JSON.parse(fs.readFileSync(path.join(desktop, 'current-version.json'), 'utf8'));
  writeJson(path.join(appDirectory, 'current-version.json'), { ...identity, editionId: 'wangzai-5.0-pilot', displayVersion: '5.0 内测版', windowTitle: '旺崽助手 · 内测版', packageOutputDirectory: 'dist-pilot', sourceDataDirectory: '.runtime-profile-pilot' });
  fs.writeFileSync(path.join(appDirectory, 'pilot-bootstrap.cjs'), pilotBootstrapSource({ delegate: false }), { flag: 'wx' });
  const bootstrapFile = path.join(appDirectory, 'src/bootstrap.cjs');
  const bootstrap = fs.readFileSync(bootstrapFile, 'utf8');
  const anchor = "const { app, protocol } = require('electron');";
  if (!bootstrap.includes(anchor)) throw new Error('PILOT_BOOTSTRAP_ANCHOR_MISSING');
  fs.writeFileSync(bootstrapFile, bootstrap.replace(anchor, `${anchor}\nrequire('../pilot-bootstrap.cjs');`));
  const mainFile = path.join(appDirectory, 'src/main.js');
  const mainSource = fs.readFileSync(mainFile, 'utf8');
  if (!/const APP_ID = ["'][^"']+["'];/u.test(mainSource)) throw new Error('PILOT_APP_ID_ANCHOR_MISSING');
  fs.writeFileSync(mainFile, mainSource.replace(/const APP_ID = ["'][^"']+["'];/u, `const APP_ID = ${JSON.stringify(PILOT_IDENTITY.appId)};`));
  const publicDirectory = path.join(output, 'server-public'); fs.mkdirSync(publicDirectory);
  const bundle = createSignedUiUpdate({ inputDirectory: path.join(assets, 'client'), privateKey, appId: PILOT_IDENTITY.appId, channel: 'pilot', sequence: 1, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  const bundleFile = path.join(publicDirectory, 'ui-pilot-1.json'); writeJson(bundleFile, bundle);
  const report = { contract: 'wangzai-pilot-installer-stage/v1', stageComplete: true, releaseReady: false, appDirectory, version,
    identity: PILOT_IDENTITY, uiPublicKeySha256: hash(publicKey), sealedManifestSha256: digest,
    assetsDirectory: assets, serverRequirements: { private_profit_core_file: coreFile, private_profit_core_sha256: candidate.server.codeSha256, private_profit_node_executable: process.execPath,
      client_updates_enabled: true, client_update_bundle_file: bundleFile, client_update_project_code: distribution.project_code, client_update_app_id: PILOT_IDENTITY.appId, client_update_channel: 'pilot' },
    notCompleted: ['server-activation', 'installer-build-and-acceptance', 'release-readiness'],
  };
  writeJson(path.join(output, 'stage-manifest.json'), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
  if (!args.has('--assets') || !args.has('--output') || [...args.keys()].some(key => !['--assets', '--output', '--ui-signing-key', '--version'].includes(key))) throw new Error('PILOT_STAGE_ARGUMENTS_REQUIRED');
  const report = stagePrivatePilotInstaller({ assetsDirectory: args.get('--assets'), outputDirectory: args.get('--output'), uiSigningPrivateKeyFile: args.get('--ui-signing-key'), version: args.get('--version') });
  console.log(JSON.stringify({ stageComplete: true, releaseReady: false, appDirectory: report.appDirectory, productName: report.identity.productName, privateKeyIncludedInClient: false }));
}
