import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), 'src');
const batchSize = Math.max(20, Math.min(120, Number(process.env.VITEST_BATCH_SIZE) || 80));
const testFilePattern = /\.test\.(?:js|jsx|ts|tsx)$/u;
const EXPLICIT_STRESS_TESTS = new Set(['v2CloudUiControlCoverage.test.jsx']);

function listTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return listTests(path);
      return entry.isFile() && testFilePattern.test(entry.name) && !EXPLICIT_STRESS_TESTS.has(entry.name)
        ? [path]
        : [];
    });
}

const files = listTests(root);
const vitestBin = resolve(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');

for (let offset = 0; offset < files.length; offset += batchSize) {
  const batch = files.slice(offset, offset + batchSize);
  const index = Math.floor(offset / batchSize) + 1;
  const total = Math.ceil(files.length / batchSize);
  console.log(`\n[vitest batch ${index}/${total}] files=${batch.length}`);
  const result = spawnSync(process.execPath, [vitestBin, 'run', ...batch], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\nVitest batches passed: files=${files.length}, batchSize=${batchSize}`);
