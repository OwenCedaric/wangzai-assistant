import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/SOURCE_COMPLETENESS.json'), 'utf8'));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const seen = new Set();
const failures = [];
for (const entry of manifest.files) {
  const file = entry.path;
  if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || seen.has(file)) {
    failures.push({ path: file, reason: 'invalid-or-duplicate-path' });
    continue;
  }
  seen.add(file);
  if (!tracked.has(file) || !fs.existsSync(path.join(root, file)) || !fs.lstatSync(path.join(root, file)).isFile()) {
    failures.push({ path: file, reason: 'source-not-published' });
  }
}
for (const prefix of ['frontend/src/', 'desktop/src/', 'desktop/native/', 'local-api/src/', 'server/app/', 'server/migrations/', 'admin/src/', 'sdk/python/license_sdk/']) {
  if (![...seen].some(file => file.startsWith(prefix))) failures.push({ path: prefix, reason: 'required-component-missing' });
}
console.log(JSON.stringify({ ok: failures.length === 0, reviewedFiles: seen.size, failures,
  scope: 'Verifies the reviewed source inventory, not production readiness or all files on the author machine.' }, null, 2));
if (failures.length) process.exitCode = 1;
