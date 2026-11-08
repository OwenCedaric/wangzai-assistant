import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveServerSourceRoot } from './server-source-root.mjs';
import { resolveDevelopmentLicenseBackend } from '../src/licensing/licenseServerBootstrap.js';

test('repository server is preferred over the old sibling backend on Windows and Unix', () => {
  const workspaceRoot = path.resolve('isolated-workspace');
  const backendRoot = path.join(workspaceRoot, 'server');
  for (const platform of ['win32', 'linux', 'darwin']) {
    const python = path.join(backendRoot, platform === 'win32' ? '.venv/Scripts/pythonw.exe' : '.venv/bin/python');
    const existsSync = file => file === path.join(backendRoot, 'app/main.py') || file === python;
    assert.equal(resolveServerSourceRoot({ workspaceRoot, env: {}, existsSync }), backendRoot);
    assert.deepEqual(resolveDevelopmentLicenseBackend({ workspaceRoot, env: {}, existsSync, platform }), {
      backendRoot, pythonExecutable: python,
    });
  }
});

test('explicit legacy roots remain supported but an invalid explicit root fails closed', () => {
  const workspaceRoot = path.resolve('isolated-workspace');
  const legacy = path.resolve('isolated-legacy');
  const existsSync = file => [path.join(legacy, 'backend/app/main.py'), path.join(workspaceRoot, 'server/app/main.py')].includes(file);
  assert.equal(resolveServerSourceRoot({ workspaceRoot, env: { LICENSE_CENTER_ROOT: legacy }, existsSync }), path.join(legacy, 'backend'));
  assert.throws(() => resolveServerSourceRoot({ workspaceRoot, env: { WANGZAI_LICENSE_BACKEND_ROOT: 'missing-explicit-root' }, existsSync }), /SERVER_SOURCE_ROOT_NOT_FOUND/u);
  assert.throws(() => resolveServerSourceRoot({ workspaceRoot, env: {}, existsSync: () => false }), /SERVER_SOURCE_ROOT_NOT_FOUND/u);
});
