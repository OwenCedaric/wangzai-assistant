import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(scriptsRoot, '..');
export const currentVersionIdentity = JSON.parse(
  await fs.readFile(path.join(desktopRoot, 'current-version.json'), 'utf8'),
);

export function currentPackageOutputRoot() {
  const directory = String(currentVersionIdentity.packageOutputDirectory || '').trim();
  if (!/^dist-[a-z0-9.-]+$/iu.test(directory)) {
    throw new Error('CURRENT_PACKAGE_OUTPUT_DIRECTORY_INVALID');
  }
  return path.join(desktopRoot, directory);
}
