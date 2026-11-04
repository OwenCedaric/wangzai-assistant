import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from './database.js';

function config(filePath) {
  return { database: { path: filePath, busyTimeoutMs: 5_000, enableWal: false } };
}

test('a new profile starts with incremental auto-vacuum before schema creation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-auto-vacuum-new-'));
  const filePath = path.join(root, 'profile.sqlite');
  const db = openDatabase(config(filePath));
  try {
    assert.equal(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2);
    db.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT);');
    assert.equal(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('opening an existing profile never silently runs a full auto-vacuum conversion', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-auto-vacuum-existing-'));
  const filePath = path.join(root, 'profile.sqlite');
  const seed = new DatabaseSync(filePath);
  seed.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT);');
  seed.close();
  const db = openDatabase(config(filePath));
  try {
    assert.equal(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE name = 'proof'`).get().count, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
