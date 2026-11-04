import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/loadConfig.js';

test('aggregate index defaults beside the shared database and cannot reuse its file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wangzai-aggregate-config-'));
  const configPath = path.join(root, 'local-api.config.json');
  const databasePath = path.join(root, 'shared.sqlite');
  const previousDatabasePath = process.env.LOCAL_API_DB_PATH;
  const previousIndexPath = process.env.LOCAL_API_AGGREGATE_INDEX_PATH;
  try {
    writeFileSync(configPath, '{}\n', 'utf8');
    process.env.LOCAL_API_DB_PATH = databasePath;
    delete process.env.LOCAL_API_AGGREGATE_INDEX_PATH;
    assert.equal(
      loadConfig(configPath).database.aggregateIndexPath,
      path.join(root, 'shop-aggregate-index.sqlite'),
    );
    process.env.LOCAL_API_AGGREGATE_INDEX_PATH = databasePath;
    assert.throws(
      () => loadConfig(configPath),
      /聚合索引必须使用独立 SQLite 文件/u,
    );
  } finally {
    if (previousDatabasePath === undefined) delete process.env.LOCAL_API_DB_PATH;
    else process.env.LOCAL_API_DB_PATH = previousDatabasePath;
    if (previousIndexPath === undefined) delete process.env.LOCAL_API_AGGREGATE_INDEX_PATH;
    else process.env.LOCAL_API_AGGREGATE_INDEX_PATH = previousIndexPath;
    rmSync(root, { recursive: true, force: true });
  }
});
