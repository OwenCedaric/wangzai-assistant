import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataLayout } from "./dataLayout.js";
import {
  clearProfileDatabaseRecoveryRequired,
  ensureProfileMetadata,
  markProfileDatabaseInitialized,
  markProfileDatabaseRecoveryRequired,
} from "./profileMetadata.js";

test("profile metadata is stable for the same data root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const first = ensureProfileMetadata(layout, {
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      createId: () => "profile-test-1",
    });
    const second = ensureProfileMetadata(layout, {
      createId: () => "must-not-be-used",
    });
    assert.deepEqual(second, first);
    assert.equal(JSON.parse(fs.readFileSync(layout.profilePath, "utf8")).profileId, "profile-test-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile metadata rejects a root fingerprint mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    fs.writeFileSync(layout.profilePath, JSON.stringify({
      schemaVersion: 1,
      profileId: "profile-test-1",
      createdAt: "2026-07-11T00:00:00.000Z",
      dataRootFingerprint: "wrong-root",
    }), "utf8");
    assert.throws(() => ensureProfileMetadata(layout), /数据根不匹配/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile metadata records database initialization only after the first healthy database exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const fresh = ensureProfileMetadata(layout, {
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      createId: () => "profile-test-1",
    });
    assert.equal(fresh.databaseLifecycle, "new");
    assert.equal(fresh.databaseInitializedAt, "");

    const initialized = markProfileDatabaseInitialized(layout, fresh, {
      now: () => new Date("2026-07-12T01:02:03.000Z"),
    });
    assert.equal(initialized.databaseLifecycle, "initialized");
    assert.equal(initialized.databaseInitializedAt, "2026-07-12T01:02:03.000Z");
    assert.equal(
      JSON.parse(fs.readFileSync(layout.profilePath, "utf8")).databaseInitializedAt,
      "2026-07-12T01:02:03.000Z",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile metadata preserves a missing initialized database as recovery-required until an explicit clear", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const fresh = ensureProfileMetadata(layout, {
      createId: () => "profile-test-1",
    });
    const initialized = markProfileDatabaseInitialized(layout, fresh, {
      now: () => new Date("2026-07-12T01:02:03.000Z"),
    });
    const recovery = markProfileDatabaseRecoveryRequired(layout, initialized, {
      now: () => new Date("2026-07-12T02:03:04.000Z"),
    });
    assert.equal(recovery.databaseLifecycle, "recovery-required");
    assert.equal(recovery.databaseRecoveryRequiredAt, "2026-07-12T02:03:04.000Z");

    const cleared = clearProfileDatabaseRecoveryRequired(layout, recovery);
    assert.equal(cleared.databaseLifecycle, "initialized");
    assert.equal(cleared.databaseRecoveryRequiredAt, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
