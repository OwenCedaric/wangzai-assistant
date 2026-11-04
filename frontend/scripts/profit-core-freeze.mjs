import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditProfitCoreFreeze } from './profit-core-freeze-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'scripts/profit-core-freeze-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const report = auditProfitCoreFreeze({ root, manifest });

process.stdout.write(
  `profit core freeze: calculation=${report.calculationVersion}, runtime=${report.runtimeVersion}, calculationFiles=${report.calculationFileCount}, runtimeFiles=${report.runtimeFileCount}, violations=${report.violations.length}\n`
);
report.violations.forEach((violation) => {
  process.stdout.write(`[error] ${violation.kind} ${violation.file || 'manifest'}: ${violation.message}\n`);
});
if (!report.ok) process.exitCode = 1;
