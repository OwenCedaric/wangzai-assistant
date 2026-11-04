import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inspectPrivateProfitBundle, privateProfitTargets } from './audit-private-profit-client.mjs';

const frontend = path.resolve(import.meta.dirname, '../../frontend');
const bundle = entries => ({ 'main.js': { type: 'chunk', modules: Object.fromEntries(entries.map(([file, renderedExports]) =>
  [path.join(frontend, file), { renderedExports }])) } });

test('the private build subgate identifies every retained protected export by module', () => {
  const report = inspectPrivateProfitBundle(bundle(Object.entries(privateProfitTargets)));
  assert.equal(report.ok, false);
  assert.equal(report.blockers.length, Object.values(privateProfitTargets).flat().length);
  assert.ok(report.blockers.every(item => item.code === 'PRIVATE_PROFIT_EXPORT_RETAINED'));
});

test('removing the entry points alone does not hide the cache migration and merge algorithms', () => {
  const report = inspectPrivateProfitBundle(bundle([['src/services/profitLedgerService.js',
    ['createProfitLedgerSnapshotFromLedgers', 'mergeProfitLedgerRows', 'migrateProfitLedgerRowToCurrentVersion']]]));
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers.map(item => item.export), ['mergeProfitLedgerRows', 'migrateProfitLedgerRowToCurrentVersion']);
});

test('public snapshot packaging is not falsely classified as private calculation', () => {
  const report = inspectPrivateProfitBundle(bundle([['src/services/profitLedgerService.js', ['createProfitLedgerSnapshotFromLedgers']]]));
  assert.equal(report.ok, true);
  assert.match(report.evidence, /not full-application secrecy/);
});
