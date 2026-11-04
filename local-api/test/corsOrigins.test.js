import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loadConfig.js';
import { createCorsHeaders, isAllowedCorsOrigin } from '../src/utils/http.js';

const exampleConfiguration = fileURLToPath(new URL('../config/local-api.config.example.json', import.meta.url));

test('continuous background sync is enabled by default and can be explicitly disabled', () => {
  const original = process.env.LOCAL_API_CONTINUOUS_SYNC;
  try {
    delete process.env.LOCAL_API_CONTINUOUS_SYNC;
    assert.equal(loadConfig(exampleConfiguration).sync.continuousEnabled, true);
    process.env.LOCAL_API_CONTINUOUS_SYNC = 'false';
    assert.equal(loadConfig(exampleConfiguration).sync.continuousEnabled, false);
  } finally {
    if (original === undefined) delete process.env.LOCAL_API_CONTINUOUS_SYNC;
    else process.env.LOCAL_API_CONTINUOUS_SYNC = original;
  }
});

test('default configuration allows the packaged desktop custom scheme', () => {
  const config = loadConfig(exampleConfiguration);

  assert.ok(config.security.allowOrigins.includes('app://wangzai'));
  assert.equal(isAllowedCorsOrigin('app://wangzai', config), true);
  assert.equal(
    createCorsHeaders(config, { headers: { origin: 'app://wangzai' } })[
      'access-control-allow-origin'
    ],
    'app://wangzai',
  );
});

test('unlisted external CORS origins stay blocked', () => {
  const config = loadConfig(exampleConfiguration);

  assert.equal(isAllowedCorsOrigin('https://untrusted.example', config), false);
});
