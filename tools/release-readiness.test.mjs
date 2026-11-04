import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditReleaseReadiness, REQUIRED_RELEASE_CHECKS } from './release-readiness.mjs';

test('release gate rejects missing modules and unexecuted checks even when the manifest claims READY', () => {
  const report = auditReleaseReadiness({ root: '.', manifest: { schemaVersion: 1, decision: 'READY', modules: [{ id: 'a' }] }, expectedModuleIds: ['a', 'b'] });
  assert.equal(report.decision, 'NOT_READY');
  assert.equal(report.blockers.length, REQUIRED_RELEASE_CHECKS.length + 1);
});

test('passed checks require immutable result and current source evidence; open blockers still prevent release', t => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-release-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'result.log'), 'fixture pass');
  writeFileSync(join(root, 'source.js'), 'fixture source');
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const receipt = { path: 'result.log', sha256: sha256('fixture pass'), exitCode: 0, executedAt: '2026-09-05T00:00:00Z',
    sourceFiles: [{ path: 'source.js', sha256: sha256('fixture source') }] };
  const manifest = { schemaVersion: 1, modules: [{ id: 'a', checks: Object.fromEntries(REQUIRED_RELEASE_CHECKS.map(name => [name, { status: 'passed', evidence: [receipt] }])) }] };
  const run = () => auditReleaseReadiness({ root, manifest, expectedModuleIds: ['a'] });
  assert.equal(run().ok, true);
  manifest.releaseBlockers = [{ id: 'unsafe-restore', status: 'open' }];
  assert.equal(run().ok, false);
  manifest.releaseBlockers = [];
  writeFileSync(join(root, 'source.js'), 'changed source');
  assert.ok(run().blockers.every(issue => issue.code === 'EVIDENCE_SOURCE_CHANGED'));
  receipt.path = '../outside.log';
  assert.ok(run().blockers.every(issue => issue.code === 'EVIDENCE_PATH_ESCAPED'));
});
