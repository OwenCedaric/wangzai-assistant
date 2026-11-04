import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditProductImageOssFreeze } from './product-image-oss-freeze-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/product-image-oss-freeze-manifest.json'), 'utf8'));
const report = auditProductImageOssFreeze({ root, manifest });
process.stdout.write(`product image oss freeze: version=${report.featureVersion}, files=${report.protectedFileCount}, contracts=${report.contractCount}, violations=${report.violations.length}\n`);
report.violations.forEach((item) => process.stdout.write(`[error] ${item.kind} ${item.file || 'manifest'}: ${item.message}\n`));
if (!report.ok) process.exitCode = 1;
