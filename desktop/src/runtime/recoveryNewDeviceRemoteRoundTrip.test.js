import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../../local-api/src/app/createApp.js';
import { openDatabase, runMigrations } from '../../../local-api/src/db/database.js';
import { decryptSecret, encryptSecret } from '../../../local-api/src/security/secretCrypto.js';
import { activateRecoveryDatabase } from './recoveryDatabaseActivator.js';

function databaseConfig(databasePath) {
  return {
    database: { path: databasePath, enableWal: false, busyTimeoutMs: 2000 },
    security: {},
    sync: { continuousEnabled: false },
    ozon: {},
  };
}

function openMigratedDatabase(databasePath) {
  const db = openDatabase(databaseConfig(databasePath));
  runMigrations(db);
  return db;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function createOpaqueRecoveryRemote() {
  const objects = new Map();
  const generations = new Map();
  const commits = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer desktop-roundtrip-token') {
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const objectMatch = url.pathname.match(/^\/api\/recovery\/objects\/([A-Za-z0-9_-]+)$/u);
    if (request.method === 'PUT' && objectMatch) {
      const bytes = await readBody(request);
      const cipherSha256 = createHash('sha256').update(bytes).digest('hex');
      const cipherBytes = Number(request.headers['x-recovery-cipher-bytes']);
      if (cipherSha256 !== request.headers['x-recovery-cipher-sha256'] || cipherBytes !== bytes.length) {
        writeJson(response, 400, { error: 'cipher mismatch' });
        return;
      }
      objects.set(objectMatch[1], bytes);
      writeJson(response, 200, { chunk_id: objectMatch[1], cipher_bytes: bytes.length, reused: false });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/recovery/generations') {
      writeJson(response, 200, [...generations.values()].map(({ object_refs: _refs, ...generation }) => generation));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/recovery/generations') {
      const commit = JSON.parse((await readBody(request)).toString('utf8'));
      commits.push(commit);
      const generationId = `generation_remote_${String(generations.size + 1).padStart(8, '0')}`;
      const generation = {
        generation_id: generationId,
        scope_key: commit.scope_key,
        owner_refs: commit.owner_refs,
        key_envelope: commit.key_envelope,
        manifest_chunk_id: commit.manifest_chunk_id,
        logical_cipher_bytes: commit.logical_cipher_bytes,
        object_refs: commit.object_refs,
      };
      generations.set(generationId, generation);
      writeJson(response, 201, generation);
      return;
    }
    const generationMatch = url.pathname.match(/^\/api\/recovery\/generations\/([A-Za-z0-9_-]+)$/u);
    if (request.method === 'GET' && generationMatch) {
      const generation = generations.get(generationMatch[1]);
      if (!generation) {
        writeJson(response, 404, { error: 'missing' });
        return;
      }
      writeJson(response, 200, generation);
      return;
    }
    const downloadMatch = url.pathname.match(/^\/api\/recovery\/generations\/([A-Za-z0-9_-]+)\/objects\/([A-Za-z0-9_-]+)$/u);
    if (request.method === 'GET' && downloadMatch) {
      const generation = generations.get(downloadMatch[1]);
      const bytes = generation && objects.get(downloadMatch[2]);
      const ref = generation?.object_refs?.find((item) => item.chunk_id === downloadMatch[2]);
      if (!bytes || !ref) {
        writeJson(response, 404, { error: 'missing' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Recovery-Cipher-Sha256': ref.cipher_sha256,
        'X-Recovery-Cipher-Bytes': String(ref.cipher_bytes),
      });
      response.end(bytes);
      return;
    }
    writeJson(response, 404, { error: 'route missing' });
  });
  return { server, commits, objects };
}

test('a new local profile restores an opaque remote generation with a new local secret and atomically activates it', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  const root = mkdtempSync(join(tmpdir(), 'wangzai-new-device-recovery-'));
  const sourcePath = join(root, 'source.sqlite');
  const targetRoot = join(root, 'target');
  const targetActivePath = join(targetRoot, 'ozon-cache.sqlite');
  const targetShellPath = join(targetRoot, 'recovery-shell.sqlite');
  const sourceSecret = 'source-device-local-secret-1234567890';
  const targetSecret = 'target-device-local-secret-9876543210';
  const passphrase = 'portable recovery passphrase';
  let sourceDb;
  let targetShellDb;
  let sourceServer;
  let targetServer;
  let remote;
  try {
    process.env.LOCAL_API_SECRET = sourceSecret;
    sourceDb = openMigratedDatabase(sourcePath);
    const sourceEncryptedApiKey = encryptSecret('source-ozon-api-key');
    sourceDb.prepare(`
      INSERT INTO shops (id, name, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shop-source', 'Source Shop', 'client-source', sourceEncryptedApiKey, 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    sourceDb.prepare(`
      INSERT INTO purchase_order_overrides (shop_id, order_key, source_cost_cny, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-source', 'order-preserve-1', 88.5, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');

    remote = createOpaqueRecoveryRemote();
    const remotePort = await listen(remote.server);
    sourceServer = createApp({
      db: sourceDb,
      config: databaseConfig(sourcePath),
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const sourcePort = await listen(sourceServer);
    const backupResponse = await fetch(`http://127.0.0.1:${sourcePort}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'backup-shop',
        shopId: 'shop-source',
        passphrase,
        remote: { baseUrl: `http://127.0.0.1:${remotePort}`, accessToken: 'desktop-roundtrip-token' },
      }),
    });
    const backup = await backupResponse.json();
    assert.equal(backupResponse.status, 200, JSON.stringify(backup));
    assert.ok(backup.remoteGenerationId);
    assert.equal(remote.commits.length, 1);
    const serverVisibleCommit = JSON.stringify(remote.commits[0]);
    assert.equal(serverVisibleCommit.includes('shop-source'), false);
    assert.equal(serverVisibleCommit.includes('source-ozon-api-key'), false);
    assert.equal(serverVisibleCommit.includes(passphrase), false);
    assert.equal([...remote.objects.values()].some((bytes) => bytes.includes(Buffer.from('source-ozon-api-key'))), false);
    await close(sourceServer);
    sourceServer = null;
    sourceDb.close();
    sourceDb = null;

    process.env.LOCAL_API_SECRET = targetSecret;
    const oldTargetDb = openMigratedDatabase(targetActivePath);
    oldTargetDb.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('old-target-shop', 'Old Target Data', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    oldTargetDb.close();
    targetShellDb = openMigratedDatabase(targetShellPath);
    targetServer = createApp({
      db: targetShellDb,
      config: databaseConfig(targetShellPath),
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const targetPort = await listen(targetServer);
    const stageResponse = await fetch(`http://127.0.0.1:${targetPort}/api/app/recovery/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'stage-restore',
        generationIds: [backup.remoteGenerationId],
        passphrase,
        remote: { baseUrl: `http://127.0.0.1:${remotePort}`, accessToken: 'desktop-roundtrip-token' },
      }),
    });
    const staged = await stageResponse.json();
    assert.equal(stageResponse.status, 200);
    assert.equal(staged.mode, 'staging-ready');
    assert.equal(staged.shops.length, 1);
    await close(targetServer);
    targetServer = null;
    targetShellDb.close();
    targetShellDb = null;

    let startedDb = null;
    const activation = await activateRecoveryDatabase({
      descriptor: staged,
      activeDatabasePath: targetActivePath,
      stopServices: async () => undefined,
      startServices: async () => {
        startedDb = openMigratedDatabase(targetActivePath);
      },
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });
    assert.equal(activation.mode, 'activated');
    assert.equal(startedDb.prepare('SELECT count(*) AS count FROM purchase_order_overrides WHERE shop_id = ?').get('shop-source').count, 1);
    assert.equal(startedDb.prepare('SELECT count(*) AS count FROM shops WHERE id = ?').get('old-target-shop').count, 0);
    const targetEncryptedApiKey = startedDb.prepare('SELECT api_key_encrypted FROM shops WHERE id = ?').get('shop-source').api_key_encrypted;
    assert.notEqual(targetEncryptedApiKey, sourceEncryptedApiKey);
    assert.equal(decryptSecret(targetEncryptedApiKey), 'source-ozon-api-key');
    startedDb.close();

    process.env.LOCAL_API_SECRET = sourceSecret;
    assert.throws(() => decryptSecret(targetEncryptedApiKey));
  } finally {
    if (sourceServer) await close(sourceServer);
    if (targetServer) await close(targetServer);
    if (sourceDb) sourceDb.close();
    if (targetShellDb) targetShellDb.close();
    if (remote?.server.listening) await close(remote.server);
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
});
