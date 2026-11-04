import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyUiBundle } from '../src/updates/signedUiBundle.js';

const workspace = path.resolve(import.meta.dirname, '../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function preparePilotServerPlan(stageDirectory) {
  const stage = path.resolve(stageDirectory);
  if (!stage.startsWith(path.join(workspace, '.codex-temp') + path.sep)) throw new Error('PILOT_SERVER_PLAN_SCOPE_INVALID');
  const output = path.join(stage, 'server-activation-plan.json');
  if (fs.existsSync(output)) throw new Error('PILOT_SERVER_PLAN_ALREADY_EXISTS');
  const stageBytes = fs.readFileSync(path.join(stage, 'stage-manifest.json'));
  const manifest = JSON.parse(stageBytes);
  if (manifest.contract !== 'wangzai-pilot-installer-stage/v1' || manifest.identity?.appId !== 'com.wangzai.assistant.desktop.pilot') throw new Error('PILOT_SERVER_PLAN_IDENTITY_INVALID');
  const required = manifest.serverRequirements;
  const expectedSettings = ['private_profit_core_file', 'private_profit_core_sha256', 'private_profit_node_executable',
    'client_updates_enabled', 'client_update_bundle_file', 'client_update_project_code', 'client_update_app_id', 'client_update_channel'];
  const project = JSON.parse(fs.readFileSync(path.join(manifest.appDirectory, 'resources/project.json'), 'utf8'));
  if (!required || Object.keys(required).sort().join('|') !== expectedSettings.sort().join('|')
    || required.client_updates_enabled !== true || required.client_update_app_id !== manifest.identity.appId
    || required.client_update_channel !== 'pilot' || required.client_update_project_code !== project.code) throw new Error('PILOT_SERVER_SETTINGS_INVALID');
  const core = fs.readFileSync(required.private_profit_core_file);
  if (sha256(core) !== required.private_profit_core_sha256) throw new Error('PILOT_SERVER_CORE_CHANGED');
  if (Number(process.versions.node.split('.')[0]) !== 24
    || fs.realpathSync(required.private_profit_node_executable).toLowerCase() !== fs.realpathSync(process.execPath).toLowerCase()) throw new Error('PILOT_SERVER_NODE_RUNTIME_MISMATCH');
  const publicKey = fs.readFileSync(path.join(manifest.appDirectory, 'resources/ui-updates/public.pem'), 'utf8');
  if (sha256(publicKey) !== manifest.uiPublicKeySha256) throw new Error('PILOT_SERVER_UPDATE_KEY_CHANGED');
  const bundleBytes = fs.readFileSync(required.client_update_bundle_file);
  const bundle = JSON.parse(bundleBytes);
  verifyUiBundle(bundle, { publicKey, appId: manifest.identity.appId, channel: 'pilot', shellApi: 1 });
  if (Date.parse(bundle.manifest.expiresAt) < Date.now() + 86400000) throw new Error('PILOT_SERVER_UPDATE_EXPIRES_SOON');
  const privateDirectory = path.join(stage, 'server-private');
  if (!fs.lstatSync(privateDirectory).isDirectory() || fs.lstatSync(privateDirectory).isSymbolicLink()) throw new Error('PILOT_SERVER_PRIVATE_DIRECTORY_INVALID');
  const deployedCore = path.join(privateDirectory, 'profit-core.mjs');
  if (fs.existsSync(deployedCore)) {
    const stat = fs.lstatSync(deployedCore);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('PILOT_SERVER_PRIVATE_CORE_UNSAFE');
    if (sha256(fs.readFileSync(deployedCore)) !== sha256(core)) throw new Error('PILOT_SERVER_PRIVATE_CORE_CONFLICT');
  } else {
    // Creating a new file inherits the server-private directory ACL; do not
    // copy a potentially permissive source-file security descriptor.
    fs.writeFileSync(deployedCore, core, { flag: 'wx', mode: 0o600 });
  }
  const plan = { contract: 'wangzai-pilot-server-activation/v1', liveServiceChanged: false,
    stageManifestSha256: sha256(stageBytes), installerVersion: manifest.version,
    settings: { ...required, private_profit_core_file: deployedCore },
    evidence: { coreSha256: sha256(core), nodeVersion: process.version, updateBundleSha256: sha256(bundleBytes),
      updateAppId: bundle.manifest.appId, updateChannel: bundle.manifest.channel, updateSequence: bundle.manifest.sequence },
    requires: ['review current service settings and preserve rollback', 'activate settings in the intended service instance', 'real authorized compute and update download verification'],
  };
  fs.writeFileSync(output, JSON.stringify(plan, null, 2), { flag: 'wx' });
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !process.argv[2].startsWith('--stage=')) throw new Error('PILOT_SERVER_PLAN_STAGE_REQUIRED');
  const plan = preparePilotServerPlan(process.argv[2].slice('--stage='.length));
  console.log(JSON.stringify({ readyForActivationReview: true, liveServiceChanged: false, installerVersion: plan.installerVersion, coreSha256: plan.evidence.coreSha256, updateSignatureVerified: true }));
}
