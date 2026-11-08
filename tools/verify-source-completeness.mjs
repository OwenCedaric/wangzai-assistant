import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const excludedDirectories = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.pnpm-store', 'dist', 'dist-package', 'build', 'bin', 'obj', 'publish', 'publish-pending', '.tools', '.selfhost', '.baseline', '.codex-temp', '.managed-dev-scratch', '.runtime', '.runtime-profile', 'artifacts', 'test-results', '.secrets']);
const sourcePattern = /\.(?:[cm]?jsx?|tsx?|vue|py|cs|csproj|sh|ps1|mako|html|css|ya?ml|toml|ini)$/iu;
const sourceNames = new Set(['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'requirements.txt', 'requirements-lock.txt', '.env.example']);
export function discoverSourceFiles(root, prefix = '') {
  const result = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const scopedRelative = [prefix, relative].filter(Boolean).join('/');
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (excludedDirectories.has(item.name) || item.name.endsWith('.egg-info') || item.name.startsWith('dist-')) continue;
        if (/^(?:admin-runtime|test-runtime)\/(?:logs|data|private|backups|public-bundle)(?:\/|$)/u.test(scopedRelative)) continue;
        if (/^deploy\/(?:secrets|generated)(?:\/|$)/u.test(scopedRelative)) continue;
        visit(absolute);
      } else if (item.isFile() && (sourcePattern.test(item.name) || sourceNames.has(item.name)
        || /^\.env.*\.example$/u.test(item.name) || /\.Dockerfile$/u.test(item.name))) result.push(relative);
    }
  }
  visit(root);
  return result.sort();
}

export function auditSourceCompleteness({ root, manifest, tracked, requiredPrefixes = [] }) {
  const seen = new Set();
  const failures = [];
  for (const entry of manifest.files || []) {
    const file = entry.path;
    if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || seen.has(file)) {
      failures.push({ path: file, reason: 'invalid-or-duplicate-path' }); continue;
    }
    seen.add(file);
    if (!tracked.has(file) || !fs.existsSync(path.join(root, file)) || !fs.lstatSync(path.join(root, file)).isFile()) failures.push({ path: file, reason: 'source-not-published' });
  }
  const discovered = discoverSourceFiles(root);
  for (const file of discovered) {
    if (!seen.has(file)) failures.push({ path: file, reason: 'source-not-in-inventory' });
    if (!tracked.has(file)) failures.push({ path: file, reason: 'source-not-tracked' });
  }
  for (const prefix of requiredPrefixes) if (![...seen].some(file => file.startsWith(prefix))) failures.push({ path: prefix, reason: 'required-component-missing' });
  return { ok: failures.length === 0, reviewedFiles: seen.size, discoveredSourceFiles: discovered.length, failures };
}

export function compareOriginalSources({ originalRoot, publicRoot, mappings }) {
  const missing = [];
  for (const [originalDirectory, publicDirectory] of Object.entries(mappings)) {
    const source = path.join(originalRoot, originalDirectory);
    if (!fs.existsSync(source)) { missing.push({ path: originalDirectory, reason: 'original-root-missing' }); continue; }
    if (fs.lstatSync(source).isFile()) {
      if (!fs.existsSync(path.join(publicRoot, publicDirectory))) missing.push({ path: publicDirectory, reason: 'original-source-not-published' });
      continue;
    }
    for (const relative of discoverSourceFiles(source, publicDirectory)) {
      let target = [publicDirectory, relative].filter(Boolean).join('/');
      if (target === 'local-api/test/productRealSkuEvidence.test.js') target = 'local-api/acceptance/productRealSkuEvidence.acceptance.mjs';
      if (!fs.existsSync(path.join(publicRoot, target))) missing.push({ path: target, reason: 'original-source-not-published' });
    }
  }
  return missing;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/SOURCE_COMPLETENESS.json'), 'utf8'));
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
  const result = auditSourceCompleteness({ root, manifest, tracked, requiredPrefixes: ['frontend/src/', 'desktop/src/', 'desktop/native/', 'local-api/src/', 'server/app/', 'server/migrations/', 'admin/src/', 'sdk/python/license_sdk/', 'admin-runtime/', 'test-runtime/scripts/'] });
  for (const kind of ['client', 'management']) {
    const argument = process.argv.find(arg => arg.startsWith(`--${kind}-root=`));
    if (argument) result.failures.push(...compareOriginalSources({ originalRoot: path.resolve(argument.slice(argument.indexOf('=') + 1)), publicRoot: root, mappings: manifest.originalSourceMappings[kind] }));
  }
  result.ok = result.failures.length === 0;
  console.log(JSON.stringify({ ...result, scope: 'Active source and deployment tooling; optional original-root comparison. Historical backups, operational data and third-party downloaded dependencies are excluded.' }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
