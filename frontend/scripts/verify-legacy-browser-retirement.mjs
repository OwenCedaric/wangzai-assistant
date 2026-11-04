import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const projectRoot = process.cwd();
const sourceRoot = join(projectRoot, 'src');
const auditManifestPath = join(sourceRoot, 'audit', 'retiredBrowserStorageAudit.js');

function listSourceFiles(directory) {
  const root = resolve(projectRoot, directory);
  const files = [];
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry);
    if (statSync(filePath).isDirectory()) files.push(...listSourceFiles(join(directory, entry)));
    else if (/\.(?:js|jsx)$/u.test(entry) && !/\.test\.(?:js|jsx)$/u.test(entry)) files.push(filePath);
  }
  return files;
}

if (!existsSync(auditManifestPath)) {
  throw new Error('The frozen account-removal audit anchor is missing.');
}
if ([
  join(sourceRoot, 'services', 'legacyBrowserRetirementManifest.js'),
  join(sourceRoot, 'services', 'browserLegacyReadStore.js'),
  join(sourceRoot, 'services', 'browserLocalStorageMirror.js'),
].some(existsSync)) {
  throw new Error('A retired browser-storage runtime file still exists.');
}

const productionSourceFiles = listSourceFiles('src');
const browserStoragePattern =
  /(?:window|globalThis)\s*\.\s*localStorage|(?<![\w.])localStorage\s*\.\s*(?:getItem|setItem|removeItem|clear)\s*\(/u;
const directBrowserStorageUsers = productionSourceFiles
  .filter((filePath) => browserStoragePattern.test(readFileSync(filePath, 'utf8')))
  .map((filePath) => relative(projectRoot, filePath).replaceAll('\\', '/'))
  .sort();

if (directBrowserStorageUsers.length !== 0) {
  throw new Error(`Retired browser persistence returned in production: ${directBrowserStorageUsers.join(', ')}`);
}

const auditManifestSource = readFileSync(auditManifestPath, 'utf8');
for (const requiredBoundary of [
  'RETIRED_BROWSER_STORAGE_AUDIT',
  "state: 'removed-no-runtime-state'",
  "mirrorResource: 'memory:renderer-browser-local-storage-mirror-retired'",
  "readListenerResource: 'runtime:renderer-legacy-browser-read-listeners-retired'",
]) {
  if (!auditManifestSource.includes(requiredBoundary)) {
    throw new Error(`Retired browser-storage audit boundary is incomplete: ${requiredBoundary}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      state: 'fully-removed-static-audit-only',
      directBrowserStorageUsers,
      compatibilityAdapter: null,
      manifestState: 'static-account-removal-anchor',
    },
    null,
    2
  )
);
