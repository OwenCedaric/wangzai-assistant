import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataLayout } from "./dataLayout.js";
import { acquireProfileLock } from "./profileLock.js";

function profile() {
  return { profileId: "profile-1", dataRootFingerprint: "fingerprint-1" };
}

test("profile lock rejects another active owner and releases only its own lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-lock-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    const lock = acquireProfileLock({ layout, profile: profile() });
    assert.throws(() => acquireProfileLock({ layout, profile: profile() }), /正被进程/u);
    lock.release();
    assert.equal(fs.existsSync(layout.profileLockPath), false);
    acquireProfileLock({ layout, profile: profile() }).release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile lock recovers a malformed stale lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-lock-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    fs.mkdirSync(path.dirname(layout.profileLockPath), { recursive: true });
    fs.writeFileSync(layout.profileLockPath, "not-json", "utf8");
    const lock = acquireProfileLock({ layout, profile: profile() });
    assert.equal(lock.profileId, "profile-1");
    lock.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile lock recovers when Windows has recycled a stale owner PID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-lock-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    fs.mkdirSync(path.dirname(layout.profileLockPath), { recursive: true });
    fs.writeFileSync(layout.profileLockPath, `${JSON.stringify({
      profileId: "profile-1",
      dataRootFingerprint: "fingerprint-1",
      pid: 18400,
      ownerToken: "stale-owner",
      acquiredAt: "2026-07-23T04:10:10.975Z",
    })}\n`, "utf8");

    const lock = acquireProfileLock({
      layout,
      profile: profile(),
      pid: 24612,
      now: () => new Date("2026-07-23T05:30:00.000Z"),
      isProcessAlive: () => true,
      inspectProcess: () => ({
        executablePath: "C:\\Program Files\\OpenAI\\Codex\\ChatGPT.exe",
        startedAtMs: Date.parse("2026-07-23T05:22:06.000Z"),
      }),
      processIdentity: {
        executablePath: "C:\\WORKSPACE\\desktop\\electron.exe",
        startedAt: "2026-07-23T05:29:59.000Z",
      },
    });

    const payload = JSON.parse(fs.readFileSync(layout.profileLockPath, "utf8"));
    assert.equal(payload.pid, 24612);
    assert.equal(payload.processIdentity.executablePath, "C:\\WORKSPACE\\desktop\\electron.exe");
    lock.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile lock keeps rejecting a live foreign process that still owns it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-lock-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    fs.mkdirSync(path.dirname(layout.profileLockPath), { recursive: true });
    fs.writeFileSync(layout.profileLockPath, `${JSON.stringify({
      profileId: "profile-1",
      dataRootFingerprint: "fingerprint-1",
      pid: 18400,
      ownerToken: "active-owner",
      acquiredAt: "2026-07-23T05:10:10.975Z",
      processIdentity: {
        executablePath: "C:\\WORKSPACE\\desktop\\electron.exe",
        startedAt: "2026-07-23T05:10:00.000Z",
      },
    })}\n`, "utf8");

    assert.throws(() => acquireProfileLock({
      layout,
      profile: profile(),
      pid: 24612,
      isProcessAlive: () => true,
      inspectProcess: () => ({
        executablePath: "C:\\WORKSPACE\\desktop\\electron.exe",
        startedAtMs: Date.parse("2026-07-23T05:10:00.000Z"),
      }),
      processIdentity: {
        executablePath: "C:\\WORKSPACE\\desktop\\electron.exe",
        startedAt: "2026-07-23T05:29:59.000Z",
      },
    }), /正被进程 18400/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a second active profile owner is rejected before the database can be written", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-lock-"));
  try {
    const layout = resolveDataLayout({ dataRoot: root });
    fs.mkdirSync(path.dirname(layout.databasePath), { recursive: true });
    fs.writeFileSync(layout.databasePath, "canonical-database-before-second-instance", "utf8");
    const lock = acquireProfileLock({ layout, profile: profile() });
    const before = fs.readFileSync(layout.databasePath, "utf8");

    assert.throws(() => acquireProfileLock({ layout, profile: profile() }), /正被进程/u);
    assert.equal(fs.readFileSync(layout.databasePath, "utf8"), before);
    lock.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
