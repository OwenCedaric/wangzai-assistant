import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentSourceWorkspace,
  loadCurrentVersionIdentity,
} from './currentVersionIdentity.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('loads the sealed current-version identity and isolated ports', () => {
  const identity = loadCurrentVersionIdentity({ desktopRoot });
  assert.equal(identity.editionId, 'wangzai-5.0-current');
  assert.equal(identity.workspaceFolderName, '旺崽助手-新版本');
  assert.equal(identity.packageOutputDirectory, 'dist-current-5.0');
  assert.deepEqual(Object.values(identity.ports), [6788, 6790, 6792, 6794]);
});

test('rejects a copied source directory while allowing packaged builds', () => {
  const identity = loadCurrentVersionIdentity({ desktopRoot });
  assert.throws(
    () => assertCurrentSourceWorkspace({
      identity,
      workspaceRoot: path.join('G:\\', '错误版本'),
      isPackaged: false,
    }),
    /CURRENT_VERSION_WORKSPACE_MISMATCH/,
  );
  assert.doesNotThrow(() => assertCurrentSourceWorkspace({
    identity,
    workspaceRoot: path.join('G:\\', '任意安装位置'),
    isPackaged: true,
  }));
});
