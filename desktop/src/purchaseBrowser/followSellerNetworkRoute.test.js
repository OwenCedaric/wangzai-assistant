import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { detectFollowSellerLoopbackHttpProxy } from './followSellerNetworkRoute.js';

test('follow-seller auto route accepts only a loopback proxy that completes an HTTPS CONNECT', async () => {
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 Connection established\r\nProxy-Agent: fixture\r\n\r\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const route = await detectFollowSellerLoopbackHttpProxy({ ports: [port], timeoutMs: 1_000 });
    assert.deepEqual(route, {
      mode: 'fixed_servers',
      rules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
      bypassRules: '<-loopback>',
      credentialRef: '',
      source: 'verified-loopback-http-proxy',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('follow-seller auto route ignores a loopback port that is not an HTTP CONNECT proxy', async () => {
  const route = await detectFollowSellerLoopbackHttpProxy({ ports: [1], timeoutMs: 150 });
  assert.equal(route, null);
});

