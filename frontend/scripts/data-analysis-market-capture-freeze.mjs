import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDataAnalysisMarketCaptureFreeze } from './data-analysis-market-capture-freeze-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'scripts/data-analysis-market-capture-freeze-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const report = auditDataAnalysisMarketCaptureFreeze({ root, manifest });

process.stdout.write(
  `data analysis market capture freeze: version=${report.featureVersion}, files=${report.protectedFileCount}, contracts=${report.contractCount}, violations=${report.violations.length}\n`,
);
report.violations.forEach((violation) => {
  process.stdout.write(`[error] ${violation.kind} ${violation.file || 'manifest'}: ${violation.message}\n`);
});
if (!report.ok) process.exitCode = 1;
