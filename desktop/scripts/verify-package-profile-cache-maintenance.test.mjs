import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPackage } from '@electron/asar';

import {
  createAsarPackageReader,
  PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES,
  verifyProfileCacheMaintenanceAsarWiring,
} from './profile-cache-maintenance-package-proof.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('proves the ordinary cache-clear flag and IPC wiring from ASAR contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-cache-package-proof-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, 'asar-source');
  const asarPath = path.join(directory, 'app.asar');
  for (const entry of PROFILE_CACHE_MAINTENANCE_ASAR_ENTRIES) {
    const relative = entry.replace(/^\/+/, '');
    const sourcePath = path.join(desktopRoot, ...relative.split('/'));
    const targetPath = path.join(sourceRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
  await createPackage(sourceRoot, asarPath);

  const reader = createAsarPackageReader(asarPath);
  const result = verifyProfileCacheMaintenanceAsarWiring(reader);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(reader.entries.has('/src/runtime/profileCacheMaintenanceMode.js'), true);
  assert.equal(reader.entries.has('/src/runtime/profileCacheMaintenanceLauncher.js'), true);

  const missingPreloadIpcReader = {
    entries: reader.entries,
    readText(entry) {
      const source = reader.readText(entry);
      return entry === '/src/preload.cjs'
        ? source.replace(/desktop:profile-cache-maintenance/gu, 'desktop:removed-channel')
        : source;
    },
  };
  const broken = verifyProfileCacheMaintenanceAsarWiring(missingPreloadIpcReader);
  assert.equal(broken.ok, false);
  assert.equal(
    broken.findings.some((finding) => (
      finding.code === 'PROFILE_CACHE_MAINTENANCE_ASAR_WIRING_MISSING'
      && finding.entry === '/src/preload.cjs'
    )),
    true,
  );
});
