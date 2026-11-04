// Same batching as scripts/run-vitest-batches.mjs, but keeps going after a failing batch
// and prints one summary line per batch plus the failing test files.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.cwd(), 'src');
const batchSize = 80;
const skip = new Set(['v2CloudUiControlCoverage.test.jsx']);
const list = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
  const p = resolve(dir, e.name);
  if (e.isDirectory()) return list(p);
  return e.isFile() && /\.test\.(?:js|jsx|ts|tsx)$/u.test(e.name) && !skip.has(e.name) ? [p] : [];
});
const files = list(root);
const vitest = resolve(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
for (let offset = 0; offset < files.length; offset += batchSize) {
  const batch = files.slice(offset, offset + batchSize);
  const r = spawnSync(process.execPath, [vitest, 'run', ...batch], { cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = strip(`${r.stdout}\n${r.stderr}`);
  const summary = out.split('\n').filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).map((l) => l.trim()).join(' | ');
  const failed = [...new Set(out.split('\n').filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim().replace(/\s+>.*$/, '')))];
  console.log(`batch ${offset / batchSize + 1}/${Math.ceil(files.length / batchSize)} exit=${r.status} ${summary}${failed.length ? `\n  ${failed.join('\n  ')}` : ''}`);
}
