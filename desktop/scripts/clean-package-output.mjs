import fs from 'node:fs';
import path from 'node:path';
import { currentPackageOutputRoot } from './current-version-identity.mjs';

const outputRoot = currentPackageOutputRoot();
for (const name of ['win-unpacked', 'win-unpacked.tmp']) {
  const target = path.join(outputRoot, name);
  const relative = path.relative(outputRoot, target);
  if (relative !== name || path.isAbsolute(relative)) {
    throw new Error('PACKAGE_OUTPUT_CLEAN_TARGET_FORBIDDEN');
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log(`[package-clean] removed ${relative}`);
}
