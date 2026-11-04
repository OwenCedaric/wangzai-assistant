import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsRoot = path.resolve(desktopRoot, '..', 'frontend', 'scripts');
const moduleRoot = path.join(scriptsRoot, 'purchase-bridge');
const moduleEntries = (await fs.readdir(moduleRoot)).sort();
const productionModuleFiles = moduleEntries
  .filter((name) => name.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/u.test(name))
  .map((name) => path.join(moduleRoot, name));
const testFiles = moduleEntries
  .filter((name) => /\.(?:test|spec)\.mjs$/u.test(name))
  .map((name) => path.join(moduleRoot, name));
const files = [
  path.join(scriptsRoot, 'purchase-search-bridge.mjs'),
  ...productionModuleFiles,
  ...testFiles,
];

for (const filePath of files) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${filePath}\n`);
    process.exit(result.status || 1);
  }
  const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/u).length - 1;
  if (lines > 500) {
    throw new Error(`Purchase bridge module exceeds 500 lines: ${filePath} (${lines})`);
  }
}

for (const filePath of productionModuleFiles) await import(pathToFileURL(filePath));
if (testFiles.length) {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Purchase bridge tests failed.\n');
    process.exit(result.status || 1);
  }
}
console.log(
  `purchase bridge source check passed (${productionModuleFiles.length + 1} production, ${testFiles.length} tests)`,
);
