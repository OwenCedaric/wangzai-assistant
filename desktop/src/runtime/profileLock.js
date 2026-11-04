import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeExecutablePath(value) {
  const normalized = String(value || "").trim();
  return normalized ? path.resolve(normalized).toLowerCase() : "";
}

function inspectWindowsProcess(pid) {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
    "[pscustomobject]@{ executablePath = $process.Path; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = execFileSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      windowsHide: true,
    });
    const details = JSON.parse(output);
    return {
      executablePath: String(details?.executablePath || ""),
      startedAtMs: Date.parse(details?.startedAt || ""),
    };
  } catch {
    return null;
  }
}

function inspectProcessIdentity(pid) {
  if (process.platform === "win32") return inspectWindowsProcess(pid);
  return null;
}

function currentProcessIdentity() {
  return {
    executablePath: process.execPath,
    startedAt: new Date(Date.now() - (process.uptime() * 1_000)).toISOString(),
  };
}

function lockStillBelongsToProcess(lock, {
  acquiringPid,
  inspectProcess,
}) {
  const ownerPid = Number(lock?.pid || 0);
  if (ownerPid === acquiringPid) return true;

  const actual = inspectProcess(ownerPid);
  // When Windows denies process metadata access, retain the conservative
  // behavior and do not steal a lock that may still have a live owner.
  if (!actual) return true;

  const actualStartedAtMs = Number(actual.startedAtMs);
  const acquiredAtMs = Date.parse(lock?.acquiredAt || "");
  if (
    Number.isFinite(actualStartedAtMs)
    && Number.isFinite(acquiredAtMs)
    && acquiredAtMs + 1_000 < actualStartedAtMs
  ) {
    // The PID now belongs to a process created after this lock. Windows has
    // recycled the PID, so the old profile lock is stale.
    return false;
  }

  const recordedStartedAtMs = Date.parse(lock?.processIdentity?.startedAt || "");
  if (
    Number.isFinite(actualStartedAtMs)
    && Number.isFinite(recordedStartedAtMs)
    && Math.abs(actualStartedAtMs - recordedStartedAtMs) > 2_000
  ) {
    return false;
  }

  const recordedExecutable = normalizeExecutablePath(
    lock?.processIdentity?.executablePath,
  );
  const actualExecutable = normalizeExecutablePath(actual.executablePath);
  if (recordedExecutable && actualExecutable && recordedExecutable !== actualExecutable) {
    return false;
  }

  return true;
}

function activeLockError(lock) {
  const pid = Number(lock?.pid || 0);
  return new Error(`数据 profile 正被进程 ${pid} 使用，请先关闭该实例后重试`);
}

/**
 * 同一 data root 同时只能由一个 desktop 主进程持有。锁内容不含凭证，且只在
 * 发现持锁进程已退出或锁文件损坏时回收陈旧锁。
 */
export function acquireProfileLock({
  layout,
  profile,
  pid = process.pid,
  now = () => new Date(),
  isProcessAlive = processIsAlive,
  inspectProcess = inspectProcessIdentity,
  processIdentity = currentProcessIdentity(),
}) {
  const lockPath = layout.profileLockPath;
  const ownerToken = crypto.randomUUID();
  const payload = {
    profileId: profile.profileId,
    dataRootFingerprint: profile.dataRootFingerprint,
    pid,
    ownerToken,
    acquiredAt: new Date(now()).toISOString(),
    processIdentity,
  };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let released = false;
      return Object.freeze({
        lockPath,
        profileId: payload.profileId,
        release() {
          if (released) return;
          released = true;
          const current = readLock(lockPath);
          if (current?.ownerToken === ownerToken) {
            fs.rmSync(lockPath, { force: true });
          }
        },
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (
        isProcessAlive(Number(existing?.pid))
        && lockStillBelongsToProcess(existing, { acquiringPid: pid, inspectProcess })
      ) {
        throw activeLockError(existing);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error("无法获取数据 profile 锁");
}
