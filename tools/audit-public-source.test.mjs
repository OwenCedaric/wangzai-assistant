import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditPublicSource } from './audit-public-source.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-source-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('rejects a private key even inside a test file and never returns its value', t => {
  const root = fixture(t);
  const marker = 'PRIVATE' + ' KEY';
  const secret = 'aB3d'.repeat(24);
  fs.writeFileSync(path.join(root, 'accidental.test.js'), `-----BEGIN ${marker}-----\n${secret}\n-----END ${marker}-----`);
  const result = auditPublicSource(root);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, 'private-key-material');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('rejects actual deployment configuration but accepts a public example', t => {
  const root = fixture(t);
  const directory = path.join(root, 'desktop/resources');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'distribution.example.json'), '{}');
  assert.equal(auditPublicSource(root).ok, true);
  fs.writeFileSync(path.join(directory, 'distribution.json'), '{}');
  assert.equal(auditPublicSource(root).ok, false);
});

test('allows loopback and official API URLs while detecting private user paths', t => {
  const root = fixture(t);
  const file = path.join(root, 'source.js');
  fs.writeFileSync(file, 'https://api-seller.ozon.ru http://127.0.0.1 https://images.example.invalid');
  assert.equal(auditPublicSource(root).ok, true);
  fs.writeFileSync(file, ['C:', 'Users', 'fixture-user', 'private.txt'].join('/'));
  const result = auditPublicSource(root);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, 'personal-home-path');
});

test('allows only the fixed RocketMQ container home in its deployment manifest', t => {
  const root = fixture(t);
  const directory = path.join(root, 'deploy/jeepay');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'docker-compose.yml');
  fs.writeFileSync(file, 'volume: ' + ['', 'home', 'rocketmq', 'store'].join('/'));
  assert.equal(auditPublicSource(root).ok, true);
  fs.writeFileSync(file, 'volume: ' + ['', 'home', 'private-user', 'store'].join('/'));
  assert.equal(auditPublicSource(root).ok, false);
  fs.writeFileSync(file, 'volume: ' + ['', 'home', 'rocketmq-private', 'store'].join('/'));
  assert.equal(auditPublicSource(root).ok, false);
  fs.writeFileSync(file, 'volume: ' + ['', 'home', 'rocketmq', 'store'].join('/'));
  fs.writeFileSync(path.join(root, 'source.js'), ['', 'home', 'rocketmq', 'private.txt'].join('/'));
  assert.equal(auditPublicSource(root).ok, false);
});
