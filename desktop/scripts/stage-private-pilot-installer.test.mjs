import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { pilotBootstrapSource, PILOT_IDENTITY, stagePrivatePilotInstaller } from './stage-private-pilot-installer.mjs';

function simulate(env) {
  const calls = [], appData = path.resolve('isolated-appdata');
  const process = { env: { ...env } };
  const app = { setName: name => calls.push(['name', name]), getPath: key => { assert.equal(key, 'appData'); return appData; },
    setPath: (key, value) => calls.push([key, value]) };
  vm.runInNewContext(pilotBootstrapSource(), { process, require: name => {
    if (name === 'electron') return { app };
    if (name === 'node:path') return path;
    assert.equal(name, './src/bootstrap.cjs'); calls.push(['boot', process.env.WANGZAI_DESKTOP_DATA_DIR]); return {};
  } });
  return { calls, env: process.env, appData };
}

test('pilot bootstrap never inherits the normal edition profile and prepares isolation before boot', () => {
  const original = { WANGZAI_DESKTOP_DATA_DIR: path.resolve('normal-profile'), LOCAL_API_PORT: '6790' };
  const result = simulate(original);
  const expected = path.join(result.appData, PILOT_IDENTITY.dataDirectory);
  assert.equal(result.env.WANGZAI_DESKTOP_DATA_DIR, expected);
  assert.equal(result.env.LOCAL_API_PORT, '6890');
  assert.deepEqual(result.calls, [['name', PILOT_IDENTITY.productName], ['userData', expected], ['boot', expected]]);
  assert.equal(original.LOCAL_API_PORT, '6790');
});

test('only the explicit pilot data override can select a test profile', () => {
  const fixture = path.resolve('pilot-only-fixture');
  const result = simulate({ WANGZAI_PILOT_DATA_DIR: fixture, WANGZAI_DESKTOP_DATA_DIR: path.resolve('normal-profile') });
  assert.equal(result.env.WANGZAI_DESKTOP_DATA_DIR, fixture);
});

test('the packaged isolation hook does not recursively re-enter the canonical bootstrap', () => {
  assert.doesNotMatch(pilotBootstrapSource({ delegate: false }), /require\('\.\/src\/bootstrap\.cjs'\)/);
  assert.match(pilotBootstrapSource({ delegate: false }), /app\.setPath\('userData', pilotData\)/);
});

test('staging rejects the workspace root before reading assets or creating signing keys', () => {
  assert.throws(() => stagePrivatePilotInstaller({ assetsDirectory: 'missing-assets', outputDirectory: path.resolve(import.meta.dirname, '../..') }), /PILOT_STAGE_MUST_BE_NEW_ISOLATED_DIRECTORY/);
});
