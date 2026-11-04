import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '../..');
const frontend = path.join(workspace, 'frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const { build } = require('esbuild');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildPrivateProfitCore({ outputDirectory, fullPipeline = false }) {
  const output = path.resolve(outputDirectory);
  for (const forbidden of [path.join(frontend, 'dist'), path.join(frontend, 'dist-package'), path.join(workspace, 'desktop/resources'), path.join(workspace, 'desktop/src')]) {
    const relative = path.relative(forbidden, output);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('PRIVATE_CORE_CLIENT_OUTPUT_FORBIDDEN');
  }
  if (fs.existsSync(output)) throw new Error('PRIVATE_CORE_OUTPUT_ALREADY_EXISTS');
  const result = await build({
    absWorkingDir: frontend, entryPoints: [fullPipeline ? '../desktop/server-core/profitExecution.mjs' : 'src/services/profitLedgerService.js'], bundle: true,
    platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true,
    outfile: 'profit-core.mjs', jsx: 'automatic', loader: { '.jsx': 'jsx', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'import.meta.env': '{}' },
    banner: { js: "import { createRequire as __privateCreateRequire } from 'node:module'; const require = __privateCreateRequire(import.meta.url);" },
  });
  const code = result.outputFiles[0].contents;
  const sources = Object.keys(result.metafile.inputs).filter(file => file.startsWith('src/') || file.startsWith('../desktop/server-core/') || file.startsWith('../shared/')).sort().map(file => ({
    path: file, sha256: sha256(fs.readFileSync(path.join(frontend, file))),
  }));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'profit-core.mjs'), code, { flag: 'wx' });
  const manifest = { contract: 'wangzai-private-profit-core-build/v1', serverOnly: true,
    buildDoesNotModifySources: true, codeSha256: sha256(code), bytes: code.length, sources,
    fullPipeline, boundary: 'Private execution candidate only. Client imports have not yet been migrated; this is not a finished thin-client release.' };
  fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fullPipeline = process.argv.includes('--full-pipeline');
  const argument = process.argv.slice(2).filter(value => value !== '--full-pipeline');
  if (argument.length !== 1 || !argument[0].startsWith('--output=')) throw new Error('PRIVATE_CORE_OUTPUT_ARGUMENT_REQUIRED');
  const manifest = await buildPrivateProfitCore({ outputDirectory: argument[0].slice('--output='.length), fullPipeline });
  console.log(JSON.stringify({ serverOnly: true, bytes: manifest.bytes, sources: manifest.sources.length, codeSha256: manifest.codeSha256 }));
}
