import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFollowSellerScheme1Freeze } from './follow-seller-scheme1-freeze-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/follow-seller-scheme1-freeze-manifest.json'), 'utf8'));
const report = auditFollowSellerScheme1Freeze({ root, manifest });

process.stdout.write(`follow seller scheme1 freeze: version=${report.featureVersion}, files=${report.protectedFileCount}, contracts=${report.contractCount}, sequences=${report.sequenceCount}, violations=${report.violations.length}\n`);
report.violations.forEach((item) => process.stdout.write(`[error] ${item.kind} ${item.file || 'manifest'}: ${item.message}\n`));
if (!report.ok) process.exitCode = 1;
