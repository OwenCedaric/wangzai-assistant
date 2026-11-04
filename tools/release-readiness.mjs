import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'automatedBehavior', 'scopeIsolation', 'faultRecovery', 'restartPersistence',
  'backupRestore', 'performance', 'packaged', 'externalReadback',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function workspaceFile(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('EVIDENCE_PATH_INVALID');
  const file = resolve(root, name);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('EVIDENCE_PATH_ESCAPED');
  if (!existsSync(file)) throw new Error('EVIDENCE_FILE_MISSING');
  return file;
}

function verifyReceipt(root, receipt) {
  if (!receipt || receipt.exitCode !== 0 || !Number.isFinite(Date.parse(receipt.executedAt))) throw new Error('EVIDENCE_RESULT_INVALID');
  if (hash(readFileSync(workspaceFile(root, receipt.path))) !== receipt.sha256) throw new Error('EVIDENCE_HASH_MISMATCH');
  if (!Array.isArray(receipt.sourceFiles) || !receipt.sourceFiles.length) throw new Error('EVIDENCE_SOURCE_VERSION_REQUIRED');
  for (const source of receipt.sourceFiles) {
    if (hash(readFileSync(workspaceFile(root, source.path))) !== source.sha256) throw new Error('EVIDENCE_SOURCE_CHANGED');
  }
}

export function auditReleaseReadiness({ root, manifest, expectedModuleIds }) {
  const blockers = [];
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const expected = new Set(expectedModuleIds);
  const seen = new Set();
  if (manifest?.schemaVersion !== 1) blockers.push({ code: 'MANIFEST_SCHEMA_INVALID' });
  for (const module of modules) {
    if (!expected.has(module.id) || seen.has(module.id)) blockers.push({ module: module.id, code: 'MODULE_UNKNOWN_OR_DUPLICATE' });
    seen.add(module.id);
    for (const name of REQUIRED_RELEASE_CHECKS) {
      const check = module.checks?.[name];
      if (check?.status === 'not-applicable' && typeof check.notes === 'string' && check.notes.trim().length >= 12) continue;
      if (check?.status !== 'passed') { blockers.push({ module: module.id, check: name, code: 'CHECK_NOT_VERIFIED', status: check?.status || 'missing' }); continue; }
      if (!Array.isArray(check.evidence) || !check.evidence.length) { blockers.push({ module: module.id, check: name, code: 'CHECK_EVIDENCE_REQUIRED' }); continue; }
      for (const receipt of check.evidence) {
        try { verifyReceipt(root, receipt); }
        catch (error) { blockers.push({ module: module.id, check: name, code: error.message }); }
      }
    }
  }
  for (const id of expected) if (!seen.has(id)) blockers.push({ module: id, code: 'MODULE_MISSING' });
  for (const issue of manifest?.releaseBlockers || []) {
    if (issue.status !== 'resolved') blockers.push({ code: 'OPEN_RELEASE_BLOCKER', id: issue.id, message: issue.message });
  }
  return { ok: !blockers.length, decision: blockers.length ? 'NOT_READY' : 'READY', moduleCount: modules.length, blockers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'docs/release-readiness/module-acceptance.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(resolve(root, 'docs/architecture-visualization/模块总账.json'), 'utf8'));
  const report = auditReleaseReadiness({ root, manifest, expectedModuleIds: catalog.modules.map(module => module.id) });
  console.log(JSON.stringify(report, null, process.argv.includes('--json') ? 2 : 0));
  if (process.argv.includes('--check') && !report.ok) process.exitCode = 1;
}
