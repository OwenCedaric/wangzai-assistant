import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureConcurrentShortcutChanges,
  captureInstallerShellShortcuts,
  captureInstallerShortcutOutputs,
  restoreInstallerShellShortcuts,
} from './installer-shell-shortcut-snapshot.mjs';

async function withShortcutFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-shortcut-'));
  const shortcutPath = path.join(root, '旺崽助手.lnk');
  try {
    await run(shortcutPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('preserves a shortcut created by the user while installer smoke is running', async () => {
  await withShortcutFixture(async (shortcutPath) => {
    const snapshots = await captureInstallerShellShortcuts([shortcutPath]);
    await fs.writeFile(shortcutPath, 'installer-shortcut');
    await captureInstallerShortcutOutputs(snapshots);
    await fs.writeFile(shortcutPath, 'current-source-shortcut');
    await captureConcurrentShortcutChanges(snapshots);
    await fs.rm(shortcutPath, { force: true }); // the smoke uninstaller removes its shortcut
    await restoreInstallerShellShortcuts(snapshots);
    assert.equal(await fs.readFile(shortcutPath, 'utf8'), 'current-source-shortcut');
  });
});

test('removes only the installer shortcut when none existed before smoke', async () => {
  await withShortcutFixture(async (shortcutPath) => {
    const snapshots = await captureInstallerShellShortcuts([shortcutPath]);
    await fs.writeFile(shortcutPath, 'installer-shortcut');
    await captureInstallerShortcutOutputs(snapshots);
    await restoreInstallerShellShortcuts(snapshots);
    await assert.rejects(fs.stat(shortcutPath), { code: 'ENOENT' });
  });
});

test('restores the original shortcut after smoke uninstall', async () => {
  await withShortcutFixture(async (shortcutPath) => {
    await fs.writeFile(shortcutPath, 'original-shortcut');
    const snapshots = await captureInstallerShellShortcuts([shortcutPath]);
    await fs.writeFile(shortcutPath, 'installer-shortcut');
    await captureInstallerShortcutOutputs(snapshots);
    await fs.rm(shortcutPath, { force: true });
    await restoreInstallerShellShortcuts(snapshots);
    assert.equal(await fs.readFile(shortcutPath, 'utf8'), 'original-shortcut');
  });
});

