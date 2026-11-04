import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditArchitecture } from './architecture-guard-core.mjs';
import { auditProductRendererBoundary } from './product-boundary-guard-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'scripts/architecture-guard-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const architectureReport = auditArchitecture({ srcRoot: resolve(root, 'src'), baseline });
const productBoundaryReport = auditProductRendererBoundary({ srcRoot: resolve(root, 'src') });
const report = {
  ...architectureReport,
  ok: architectureReport.ok && productBoundaryReport.ok,
  summary: {
    ...architectureReport.summary,
    productFeatureFiles: productBoundaryReport.summary.featureFiles,
    productBoundaryViolations: productBoundaryReport.summary.violations,
  },
  violations: [...architectureReport.violations, ...productBoundaryReport.violations],
  productBoundary: productBoundaryReport,
};
const output = JSON.stringify(report, null, 2);

if (process.argv.includes('--json')) process.stdout.write(`${output}\n`);
else {
  process.stdout.write(
    `architecture guard: modules=${report.summary.modules}, cycles=${report.summary.importCycles}, new=${report.summary.newViolations}, product-boundary=${report.summary.productBoundaryViolations}\n`
  );
  report.violations.forEach((violation) => {
    process.stdout.write(
      `[${violation.severity}] ${violation.rule} ${violation.kind}: ${violation.file ?? violation.files?.join(', ') ?? 'unknown'}\n`
    );
  });
}

if (process.argv.includes('--enforce') && !report.ok) process.exitCode = 1;
