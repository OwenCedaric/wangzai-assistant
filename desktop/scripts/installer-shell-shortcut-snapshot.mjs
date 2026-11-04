import fs from 'node:fs/promises';
import path from 'node:path';

async function readBytes(filePath) {
  return fs.readFile(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.compare(left, right) === 0;
}

export async function captureInstallerShellShortcuts(shortcutPaths) {
  return Promise.all(shortcutPaths.map(async (shortcutPath) => ({
    path: shortcutPath,
    originalBytes: await readBytes(shortcutPath),
    installerBytes: null,
    concurrentBytes: undefined,
  })));
}

export async function captureInstallerShortcutOutputs(snapshots = []) {
  for (const snapshot of snapshots) {
    snapshot.installerBytes = await readBytes(snapshot.path);
  }
  return snapshots;
}

export async function captureConcurrentShortcutChanges(snapshots = []) {
  for (const snapshot of snapshots) {
    const currentBytes = await readBytes(snapshot.path);
    if (currentBytes && !sameBytes(currentBytes, snapshot.installerBytes)) {
      snapshot.concurrentBytes = currentBytes;
    }
  }
  return snapshots;
}

export async function restoreInstallerShellShortcuts(snapshots = []) {
  for (const snapshot of snapshots) {
    const desiredBytes = snapshot.concurrentBytes === undefined
      ? snapshot.originalBytes
      : snapshot.concurrentBytes;
    const currentBytes = await readBytes(snapshot.path);

    // A shortcut created or changed outside the smoke installer always wins.
    if (currentBytes && !sameBytes(currentBytes, snapshot.installerBytes)) {
      continue;
    }

    if (desiredBytes) {
      await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
      await fs.writeFile(snapshot.path, desiredBytes);
    } else if (currentBytes && sameBytes(currentBytes, snapshot.installerBytes)) {
      await fs.rm(snapshot.path, { force: true });
    }
  }
}

