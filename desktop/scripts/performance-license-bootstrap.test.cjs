'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'performance-license-bootstrap.cjs'), 'utf8');
function runAdapter(overrides = {}) {
  const directory = path.resolve(__dirname, '../../.managed-dev-scratch/run-00000000-0000-0000-0000-000000000000/work/authorization');
  const configuration = { license_mode: 'enforce', campaign_code: 'test-fixture', license_center_url: 'http://127.0.0.1:18001', ...overrides.configuration };
  const events = [];
  const fakeFs = {
    lstatSync: () => ({ isSymbolicLink: () => Boolean(overrides.symlink) }),
    readFileSync: file => file.endsWith('distribution.json') ? JSON.stringify(configuration)
      : file.endsWith('credentials.private.json') ? JSON.stringify({ email: overrides.email || 'isolated-customer@fixture.invalid', password: 'synthetic' })
        : 'test project',
    appendFileSync: (_file, value) => events.push(JSON.parse(value)),
  };
  const app = { isPackaged: Boolean(overrides.packaged), on: event => events.push({ listener: event }) };
  const context = { __dirname, URL, console, setTimeout,
    process: { type: 'browser', pid: 1, versions: { electron: 'test' }, argv: overrides.argv || ['--performance-test', '--dashboard-visual-test'],
      env: { WANGZAI_PERFORMANCE_LICENSE_DIRECTORY: overrides.directory || directory, WANGZAI_PERFORMANCE_NETWORK_LOG: 'test-only' } },
    require: name => ({ 'node:fs': fakeFs, 'node:path': path, 'node:assert/strict': assert,
      'node:module': { syncBuiltinESMExports() {} }, electron: { app } })[name],
  };
  vm.runInNewContext(source, context, { timeout: 1000 });
  return events;
}

test('test login adapter refuses packaged apps, unrelated paths and symlinked fixture roots', () => {
  for (const options of [{ packaged: true }, { directory: path.resolve(__dirname, '../resources') }, { symlink: true }, { argv: [] }]) {
    assert.throws(() => runAdapter(options));
  }
});

test('test login adapter requires enforced loopback test campaign and synthetic credentials', () => {
  for (const options of [{ configuration: { license_mode: 'off' } }, { configuration: { campaign_code: 'production' } },
    { configuration: { license_center_url: 'https://example.invalid' } }, { email: 'not-a-fixture@example.invalid' }]) {
    assert.throws(() => runAdapter(options));
  }
});

test('valid test adapter registers only the owned browser-window login hook', () => {
  assert.deepEqual(runAdapter(), [{ event: 'auth-adapter', phase: 'installed', pid: 1 }, { listener: 'browser-window-created' }]);
});
