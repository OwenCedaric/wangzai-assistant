import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '../..');
const frontend = path.join(workspace, 'frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);

// Rendered-export evidence from an actual pilot build. This is a conservative
// profit-only subgate, not an assertion that all proprietary app code is gone.
export const privateProfitTargets = {
  'src/entities/profit/profitDisplayRules.jsx': ['normalizeOzonProfitOrder', 'rebuildProfitLedgerWithManualOverride'],
  'src/entities/profit/profitLedgerMapping.jsx': ['rebuildProfitLedgerForFinalZeroActualSales'],
  'src/services/profitLedgerService.js': ['createProfitLedgerRow', 'createProfitLedgerSnapshot', 'mergeProfitLedgerRows', 'migrateProfitLedgerRowToCurrentVersion', 'resolveProfitPurchaseCost'],
};

export function inspectPrivateProfitBundle(bundle) {
  const observed = new Map(), blockers = [];
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    for (const [moduleId, module] of Object.entries(chunk.modules ?? {})) {
      const normalized = path.relative(frontend, moduleId).replaceAll('\\', '/');
      if (!privateProfitTargets[normalized]) continue;
      const exports = observed.get(normalized) ?? new Set();
      module.renderedExports.forEach(name => exports.add(name));
      observed.set(normalized, exports);
    }
  }
  for (const [file, targets] of Object.entries(privateProfitTargets)) {
    for (const name of targets) if (observed.get(file)?.has(name)) blockers.push({ file, export: name, code: 'PRIVATE_PROFIT_EXPORT_RETAINED' });
  }
  return { contract: 'wangzai-private-profit-client-audit/v1', pilotBuild: true,
    ok: blockers.length === 0, blockers,
    evidence: 'Rollup rendered exports from actual production pilot compilation; not full-application secrecy or runtime acceptance.',
    targets: privateProfitTargets,
    observed: Object.fromEntries([...observed].map(([file, values]) => [file, [...values].sort()])),
  };
}

export async function auditPrivateProfitClient() {
  let report;
  await build({ root: frontend, configFile: path.join(frontend, 'vite.config.js'), logLevel: 'silent',
    define: { 'import.meta.env.VITE_PRIVATE_PROFIT_CORE': '"1"' },
    build: { write: false },
    plugins: [{ name: 'private-profit-export-audit', generateBundle(_options, bundle) { report = inspectPrivateProfitBundle(bundle); } }],
  });
  if (!report || !Object.keys(report.observed).length) throw new Error('PRIVATE_PROFIT_BUILD_EVIDENCE_MISSING');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--report=')) throw new Error('PRIVATE_PROFIT_REPORT_REQUIRED');
  const reportPath = path.resolve(args[0].slice('--report='.length));
  const relative = path.relative(path.join(workspace, '.codex-temp'), reportPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(reportPath)) throw new Error('PRIVATE_PROFIT_REPORT_PATH_INVALID');
  const report = await auditPrivateProfitClient();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ok: report.ok, blockers: report.blockers, reportPath }));
  if (!report.ok) process.exitCode = 1;
}
