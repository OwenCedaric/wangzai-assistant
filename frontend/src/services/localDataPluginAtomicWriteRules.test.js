import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import localDataPlugin, { queueDataFileWrite, writeDataFile } from '../../localDataPlugin.js';
import { readSplitAppSource } from '../test/appSource';

const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const appSource = readSplitAppSource();

function createMiddleware(dataRootDirectory) {
  let handler = null;
  localDataPlugin({ dataRootDirectory }).configureServer({
    middlewares: {
      use(nextHandler) {
        handler = nextHandler;
      },
    },
  });
  if (!handler) throw new Error('local data middleware was not registered');
  return handler;
}

function invokeMiddleware(handler, { method = 'GET', url, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = url;
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(raw) {
        let payload = {};
        try {
          payload = JSON.parse(String(raw || '{}'));
        } catch {
          // The test reports a useful assertion below if JSON framing regresses.
        }
        resolve({ statusCode: this.statusCode, payload });
      },
    };
    Promise.resolve(handler(request, response, () => reject(new Error('request fell through middleware')))).catch(reject);
  });
}

describe('local data plugin atomic write rules', () => {
  it('writes local JSON through a temp file and atomic rename', () => {
    const writeDataFileStart = pluginSource.indexOf('async function writeDataFile');
    const queueStart = pluginSource.indexOf('function queueDataFileWrite');
    expect(writeDataFileStart).toBeGreaterThanOrEqual(0);
    expect(queueStart).toBeGreaterThan(writeDataFileStart);

    const writeDataFileSource = pluginSource.slice(writeDataFileStart, queueStart);
    expect(writeDataFileSource).toContain('tempFilePath');
    expect(writeDataFileSource).toContain('await fs.writeFile(tempFilePath');
    expect(writeDataFileSource).toContain('await fs.rename(tempFilePath, filePath)');
    expect(writeDataFileSource).toContain('await fs.rm(tempFilePath');
    expect(writeDataFileSource).not.toContain('await fs.writeFile(filePath');
  });

  it('serializes writes per target file before responding to local data PUT/POST', () => {
    expect(pluginSource).toContain('const writeQueues = new Map();');
    expect(pluginSource).toContain('function queueDataFileWrite(filePath, writeTask)');
    expect(pluginSource).toContain('const previousWrite = writeQueues.get(filePath) ?? Promise.resolve();');
    expect(pluginSource).toContain(
      'await queueDataFileWrite(filePath, () => writeDataFile(dataDirectory, filePath, data));'
    );
  });

  it('atomically writes real JSON files and leaves no temp file behind on success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wangzai-local-data-atomic-'));
    const filePath = join(directory, 'cache.json');

    try {
      await writeDataFile(directory, filePath, { rows: [{ id: '1' }], updatedAt: '2026-06-27T00:00:00.000Z' });

      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      expect(parsed).toEqual({ rows: [{ id: '1' }], updatedAt: '2026-06-27T00:00:00.000Z' });
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps queued writes ordered for the same target file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wangzai-local-data-queue-'));
    const filePath = join(directory, 'cache.json');

    try {
      await Promise.all([
        queueDataFileWrite(filePath, () => writeDataFile(directory, filePath, { version: 1 })),
        queueDataFileWrite(filePath, () => writeDataFile(directory, filePath, { version: 2 })),
      ]);

      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the previous cache file intact when a write fails before rename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wangzai-local-data-failed-'));
    const filePath = join(directory, 'cache.json');
    const circular = { version: 2 };
    circular.self = circular;

    try {
      await writeDataFile(directory, filePath, { version: 1, rows: ['kept'] });
      await expect(writeDataFile(directory, filePath, circular)).rejects.toThrow();

      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, rows: ['kept'] });
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps retired plugin and marketing cache inputs behind fixed migration-only endpoints', () => {
    [
      "'ozon-shop-settings'",
      "'sales-source-links'",
      "'cross-border-bus-order-records'",
      "'purchase-source-links'",
    ].forEach((key) => {
      expect(pluginSource).toContain(key);
    });
    expect(pluginSource).toContain("const RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE = '/legacy-migration-api/purchase-source-plugin-context';");
    expect(pluginSource).toContain("const RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE = '/legacy-migration-api/marketing-activity-cache';");
    expect(pluginSource).toContain("fileName: 'purchase-source-plugin-context.json'");
    expect(pluginSource).toContain("fileName: 'marketing-activity-cache.json'");
    expect(pluginSource).toContain("message: 'Retired purchase plugin context is migration-only.'");
    expect(pluginSource).toContain("message: 'Retired marketing activity cache is migration-only.'");
    expect(pluginSource).toContain("code: 'LEGACY_SOURCE_CHANGED'");
    expect(pluginSource).toContain('createHash(\'sha256\')');
    expect(pluginSource).toContain('await queueDataFileWrite(filePath, async () => {');
    expect(pluginSource).toContain('await fs.rm(filePath, { force: false });');
  });

  it('removes retired aggregate and browser cache files from the generic JSON registry', () => {
    expect(pluginSource).toContain('const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;');
    [
      'after-sales-display-snapshots',
      'profit-local-cache',
      'local-mirror-read-log',
      'local-mirror-retry-queue',
      'browser-local-storage',
    ].forEach((key) => {
      expect(pluginSource).not.toContain(`'${key}': {`);
    });
  });

  it('registers every generic App local data file key with the Vite local data plugin', () => {
    const blockedLegacyKeys = new Set([
      'ozon-local-data-layer',
      'after-sales-display-snapshots',
      'profit-local-cache',
      'local-mirror-read-log',
      'local-mirror-retry-queue',
      'browser-local-storage',
      'purchase-source-plugin-context',
      'marketing-activity-cache',
    ]);
    const appFileKeys = [...appSource.matchAll(/const\s+[A-Z0-9_]*FILE_KEY\s*=\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((key) => !blockedLegacyKeys.has(key));
    const pluginFileKeys = new Set(
      [...pluginSource.matchAll(/'([^']+)':\s*\{\s*directory:/g)].map((match) => match[1])
    );

    expect(appFileKeys.length).toBeGreaterThan(0);
    expect(appFileKeys.filter((key) => !pluginFileKeys.has(key))).toEqual([]);
  });

  it('resolves local data files only through the whitelisted file registry', () => {
    expect(pluginSource).toContain('const fileConfig = LOCAL_DATA_FILES[key];');
    expect(pluginSource).toContain("sendJson(res, 404, { ok: false, message: 'Not found' });");
    expect(pluginSource).toContain('const dataDirectory = path.join(dataRootDirectory, fileConfig.directory);');
    expect(pluginSource).toContain('const filePath = path.join(dataDirectory, fileConfig.fileName);');
    expect(pluginSource).not.toContain('path.join(dataRootDirectory, key');
    expect(pluginSource).not.toContain('path.resolve(dataRootDirectory, key');
  });

  it('freezes every former generic business JSON route without recreating its file', async () => {
    const dataRootDirectory = await mkdtemp(join(tmpdir(), 'wangzai-generic-json-frozen-'));
    const handler = createMiddleware(dataRootDirectory);

    try {
      const read = await invokeMiddleware(handler, { url: '/local-data-api/sales-source-links' });
      const write = await invokeMiddleware(handler, {
        method: 'PUT',
        url: '/local-data-api/sales-source-links',
        body: { 'shop-1:order-1': { links: [] } },
      });

      expect(read).toMatchObject({ statusCode: 410, payload: { ok: false } });
      expect(write).toMatchObject({ statusCode: 410, payload: { ok: false } });
      await expect(access(join(dataRootDirectory, '分类缓存', '05-销售订单', 'sales-source-links.json')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dataRootDirectory, { recursive: true, force: true });
    }
  });

  it('uses raw-byte SHA-256 conditional deletion for the retired marketing file and blocks every generic method', async () => {
    const dataRootDirectory = await mkdtemp(join(tmpdir(), 'wangzai-marketing-retired-'));
    const dataDirectory = join(dataRootDirectory, '分类缓存', '12-营销活动');
    const filePath = join(dataDirectory, 'marketing-activity-cache.json');
    const raw = '{\n  "shop-1": { "activityRows": [] }\n}\n';
    const handler = createMiddleware(dataRootDirectory);

    try {
      await writeDataFile(dataDirectory, filePath, { placeholder: true });
      await writeFile(filePath, raw, 'utf8');
      const expectedRevision = createHash('sha256').update(Buffer.from(raw)).digest('hex');

      const read = await invokeMiddleware(handler, {
        url: '/legacy-migration-api/marketing-activity-cache',
      });
      expect(read).toMatchObject({
        statusCode: 200,
        payload: {
          ok: true,
          exists: true,
          revision: expectedRevision,
          data: { 'shop-1': { activityRows: [] } },
        },
      });

      const stale = await invokeMiddleware(handler, {
        method: 'PUT',
        url: '/legacy-migration-api/marketing-activity-cache',
        body: { expectedRevision: '0'.repeat(64) },
      });
      expect(stale).toMatchObject({
        statusCode: 409,
        payload: { ok: false, code: 'LEGACY_SOURCE_CHANGED' },
      });
      expect(await readFile(filePath, 'utf8')).toBe(raw);

      const removed = await invokeMiddleware(handler, {
        method: 'PUT',
        url: '/legacy-migration-api/marketing-activity-cache',
        body: { expectedRevision },
      });
      expect(removed).toMatchObject({ statusCode: 200, payload: { ok: true, exists: false, data: {} } });
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const generic = await invokeMiddleware(handler, {
        method: 'POST',
        url: '/local-data-api/marketing-activity-cache',
        body: { replacement: 'must-not-write' },
      });
      expect(generic).toMatchObject({ statusCode: 410, payload: { ok: false } });
    } finally {
      await rm(dataRootDirectory, { recursive: true, force: true });
    }
  });
});
