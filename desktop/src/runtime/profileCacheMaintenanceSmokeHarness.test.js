import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT,
  consumeProfileCacheMaintenanceSmokeCapability,
  profileCacheMaintenanceSmokePaths,
  revalidateProfileCacheMaintenanceSmokeCapability,
  writeProfileCacheMaintenanceSmokeResult,
} from "./profileCacheMaintenanceSmokeHarness.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(prefix = "cache-smoke-harness-") {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const isolatedParent = path.join(ownerRoot, ".desktop-runtime-test");
  const dataRoot = path.join(isolatedParent, "run-1");
  const databasePath = path.join(
    dataRoot,
    "local-api-data",
    "wangzai-local-api.sqlite",
  );
  const token = randomBytes(32).toString("base64url");
  const database = Buffer.from("fixture-database");
  const paths = profileCacheMaintenanceSmokePaths(dataRoot);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.markerPath), { recursive: true });
  fs.writeFileSync(databasePath, database);
  fs.writeFileSync(paths.markerPath, JSON.stringify({
    contract: PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT,
    databaseSha256: hash(database),
    tokenSha256: hash(token),
  }));
  return {
    ownerRoot,
    isolatedParent,
    dataRoot,
    databasePath,
    database,
    token,
    paths,
  };
}

function consume(fixture, overrides = {}) {
  return consumeProfileCacheMaintenanceSmokeCapability({
    enabled: true,
    isPackaged: true,
    isSmokeTest: true,
    dataRoot: fixture.dataRoot,
    databasePath: fixture.databasePath,
    token: fixture.token,
    ...overrides,
  });
}

test("packaged smoke capability is one-shot, hash-bound and isolated", () => {
  const fixture = createFixture();
  try {
    const capability = consume(fixture);
    assert.equal(fs.existsSync(fixture.paths.markerPath), false);
    assert.equal(capability.resultPath, fixture.paths.resultPath);
    assert.equal(
      revalidateProfileCacheMaintenanceSmokeCapability(capability),
      capability,
    );
    writeProfileCacheMaintenanceSmokeResult(capability, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.paths.resultPath, "utf8")), {
      ok: true,
    });
    assert.throws(() => consume(fixture));
  } finally {
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("smoke capability rejects normal profiles and unpackaged runs", () => {
  const fixture = createFixture("cache-smoke-reject-");
  const normalRoot = path.join(fixture.ownerRoot, "normal-profile");
  try {
    assert.throws(
      () => consume(fixture, { dataRoot: normalRoot }),
      /DATA_ROOT_REJECTED/u,
    );
    assert.throws(
      () => consume(fixture, { isPackaged: false }),
      /FENCE_INVALID/u,
    );
  } finally {
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("smoke capability rejects the wrong one-shot token without consuming it", () => {
  const fixture = createFixture("cache-smoke-token-");
  try {
    assert.throws(
      () => consume(fixture, {
        token: randomBytes(32).toString("base64url"),
      }),
      /CAPABILITY_MISMATCH/u,
    );
    assert.equal(fs.existsSync(fixture.paths.markerPath), true);
    assert.ok(consume(fixture));
  } finally {
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("smoke capability rejects database tampering after marker creation", () => {
  const fixture = createFixture("cache-smoke-tamper-");
  try {
    fs.appendFileSync(fixture.databasePath, "tampered");
    assert.throws(() => consume(fixture), /CAPABILITY_MISMATCH/u);
    assert.equal(fs.existsSync(fixture.paths.markerPath), true);
  } finally {
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("smoke capability rejects a hard-linked database", () => {
  const fixture = createFixture("cache-smoke-hardlink-");
  const secondLink = path.join(fixture.ownerRoot, "database-hardlink.sqlite");
  try {
    fs.linkSync(fixture.databasePath, secondLink);
    assert.equal(fs.lstatSync(fixture.databasePath).nlink, 2);
    assert.throws(() => consume(fixture), /hard link/u);
    assert.equal(fs.existsSync(fixture.paths.markerPath), true);
  } finally {
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("smoke capability rejects a junction or symlinked owner directory", (t) => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cache-smoke-junction-"));
  const actualParent = path.join(ownerRoot, "actual-owner");
  const linkedParent = path.join(ownerRoot, ".desktop-runtime-test");
  const dataRoot = path.join(linkedParent, "run-1");
  const actualDataRoot = path.join(actualParent, "run-1");
  const databasePath = path.join(
    dataRoot,
    "local-api-data",
    "wangzai-local-api.sqlite",
  );
  const actualDatabasePath = path.join(
    actualDataRoot,
    "local-api-data",
    "wangzai-local-api.sqlite",
  );
  const token = randomBytes(32).toString("base64url");
  const database = Buffer.from("junction-database");
  const paths = profileCacheMaintenanceSmokePaths(dataRoot);
  try {
    fs.mkdirSync(path.dirname(actualDatabasePath), { recursive: true });
    fs.mkdirSync(path.join(actualDataRoot, "runtime"), { recursive: true });
    fs.writeFileSync(actualDatabasePath, database);
    try {
      fs.symlinkSync(
        actualParent,
        linkedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`当前文件系统不能创建测试 junction/symlink：${error.code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(paths.markerPath, JSON.stringify({
      contract: PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT,
      databaseSha256: hash(database),
      tokenSha256: hash(token),
    }));
    assert.throws(
      () => consumeProfileCacheMaintenanceSmokeCapability({
        enabled: true,
        isPackaged: true,
        isSmokeTest: true,
        dataRoot,
        databasePath,
        token,
      }),
      /non-link directory|junction|symbolic link/u,
    );
  } finally {
    try {
      fs.rmSync(linkedParent, { force: true });
    } catch {
      // The recursive cleanup below also owns the link target and test root.
    }
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test("consumed capability rejects a run directory replaced by a junction", (t) => {
  const fixture = createFixture("cache-smoke-swap-");
  const capability = consume(fixture);
  const originalRoot = path.join(fixture.ownerRoot, "original-run");
  const redirectedRoot = path.join(fixture.ownerRoot, "redirected-run");
  let linkCreated = false;
  try {
    fs.renameSync(fixture.dataRoot, originalRoot);
    fs.mkdirSync(path.join(redirectedRoot, "local-api-data"), { recursive: true });
    fs.mkdirSync(path.join(redirectedRoot, "runtime"), { recursive: true });
    fs.copyFileSync(
      path.join(originalRoot, "local-api-data", "wangzai-local-api.sqlite"),
      path.join(redirectedRoot, "local-api-data", "wangzai-local-api.sqlite"),
    );
    try {
      fs.symlinkSync(
        redirectedRoot,
        fixture.dataRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      linkCreated = true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`当前文件系统不能创建测试 junction/symlink：${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => revalidateProfileCacheMaintenanceSmokeCapability(capability),
      /non-link directory|junction|symbolic link/u,
    );
  } finally {
    if (linkCreated) {
      try { fs.rmSync(fixture.dataRoot, { force: true }); } catch { /* owned test link */ }
    }
    fs.rmSync(fixture.ownerRoot, { recursive: true, force: true });
  }
});

test("consumed capability rejects a changed or hard-linked database", () => {
  const changedFixture = createFixture("cache-smoke-revalidate-change-");
  const changedCapability = consume(changedFixture);
  try {
    fs.appendFileSync(changedFixture.databasePath, "changed-after-preview");
    assert.throws(
      () => revalidateProfileCacheMaintenanceSmokeCapability(changedCapability),
      /DATABASE_CHANGED/u,
    );
  } finally {
    fs.rmSync(changedFixture.ownerRoot, { recursive: true, force: true });
  }

  const linkedFixture = createFixture("cache-smoke-revalidate-link-");
  const linkedCapability = consume(linkedFixture);
  const hardlink = path.join(linkedFixture.ownerRoot, "post-consume-hardlink.sqlite");
  try {
    fs.linkSync(linkedFixture.databasePath, hardlink);
    assert.throws(
      () => revalidateProfileCacheMaintenanceSmokeCapability(linkedCapability),
      /hard link/u,
    );
  } finally {
    fs.rmSync(linkedFixture.ownerRoot, { recursive: true, force: true });
  }
});
