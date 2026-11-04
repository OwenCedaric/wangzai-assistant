import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildPrivateProfitCore } from './build-private-profit-core.mjs';
import { inspectPrivateProfitBundle } from './audit-private-profit-client.mjs';
import { PRIVATE_PROFIT_VERSION, PRIVATE_PROFIT_OPERATIONS } from '../../shared/profitCoreWire.js';
import { validateUiAssetPath } from '../src/updates/signedUiBundle.js';

const workspace = path.resolve(import.meta.dirname, '../..');
const frontend = path.join(workspace, 'frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const sha256 = data => createHash('sha256').update(data).digest('hex');

function filesUnder(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('PILOT_ASSET_LINK_FORBIDDEN');
    if (entry.isDirectory()) return filesUnder(file, base);
    const name = path.relative(base, file).replaceAll('\\', '/');
    validateUiAssetPath(name);
    if (!entry.isFile() || !(name === 'index.html' || name === 'favicon.png' || name.startsWith('assets/')) || /\.(map|pem|key|db|sqlite|mjs)$/iu.test(name)) throw new Error('PILOT_CLIENT_RESOURCE_FORBIDDEN');
    const bytes = fs.readFileSync(file);
    return [{ path: name, bytes: bytes.length, sha256: sha256(bytes) }];
  });
}

export async function buildPrivateProfitPilotAssets(outputDirectory) {
  const output = path.resolve(outputDirectory);
  const relative = path.relative(path.join(workspace, '.codex-temp'), output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(output)) throw new Error('PILOT_OUTPUT_MUST_BE_NEW_ISOLATED_DIRECTORY');
  fs.mkdirSync(output, { recursive: true });
  // Server payload remains a sibling, never an ancestor or child of UI assets.
  const server = await buildPrivateProfitCore({ outputDirectory: path.join(output, 'server'), fullPipeline: true });
  let audit;
  await build({ root: frontend, configFile: path.join(frontend, 'vite.config.js'),
    define: { 'import.meta.env.VITE_PRIVATE_PROFIT_CORE': '"1"' }, logLevel: 'silent',
    build: { outDir: path.join(output, 'client'), emptyOutDir: false },
    plugins: [{ name: 'pilot-private-profit-gate', generateBundle(_options, bundle) {
      audit = inspectPrivateProfitBundle(bundle);
      if (!Object.keys(audit.observed).length || !audit.ok) throw new Error('PILOT_PRIVATE_PROFIT_BOUNDARY_FAILED');
    } }],
  });
  const files = filesUnder(path.join(output, 'client'));
  if (!files.some(file => file.path === 'index.html')) throw new Error('PILOT_CLIENT_INDEX_MISSING');
  const manifest = { contract: 'wangzai-private-profit-pilot-assets/v1', assetBuildComplete: true,
    installable: false, releaseReady: false, calculationVersion: PRIVATE_PROFIT_VERSION,
    operations: [...PRIVATE_PROFIT_OPERATIONS], client: { directory: 'client', files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    server: { directory: 'server', codeSha256: server.codeSha256, bytes: server.bytes },
    audit, remainingAcceptance: ['whole-application-private-boundary', 'signed-distribution-and-update-config', 'server-deployment', 'installer-upgrade-and-real-pc-acceptance'],
  };
  fs.writeFileSync(path.join(output, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--output=')) throw new Error('PILOT_OUTPUT_REQUIRED');
  const manifest = await buildPrivateProfitPilotAssets(args[0].slice('--output='.length));
  console.log(JSON.stringify({ assetBuildComplete: true, releaseReady: false, clientBytes: manifest.client.bytes,
    serverBytes: manifest.server.bytes, serverSha256: manifest.server.codeSha256, privateProfitBoundary: manifest.audit.ok }));
}
