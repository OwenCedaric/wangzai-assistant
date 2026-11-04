import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { decryptSecret, encryptSecret } from "../../security/secretCrypto.js";
import { ProtectedComputeError } from "./protectedComputeError.js";

const CONTRACT = "protected-compute-version-state/v1";
const MAX_STATE_BYTES = 64 * 1024;
const STATE_FIELDS = Object.freeze([
  "configIdentity",
  "configVersion",
  "contract",
  "issuedAt",
  "revocationEpoch",
  "revokedCapabilities",
  "revokedKeyIds",
]);

function fail(message, cause) {
  throw new ProtectedComputeError(
    "PROTECTED_COMPUTE_VERSION_STATE_INVALID",
    message,
    { cause, status: 503, retriable: false },
  );
}

function validateList(values, pattern, label) {
  if (
    !Array.isArray(values)
    || values.some((value) => typeof value !== "string" || !pattern.test(value))
    || new Set(values).size !== values.length
  ) {
    fail(`Protected-compute version state ${label} is invalid.`);
  }
  return Object.freeze([...values]);
}

export function normalizeProtectedComputeVersionState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Protected-compute version state must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== STATE_FIELDS.length
    || keys.some((key, index) => key !== STATE_FIELDS[index])
    || value.contract !== CONTRACT
    || !/^[a-f0-9]{64}$/u.test(value.configIdentity || "")
    || !Number.isSafeInteger(value.configVersion)
    || value.configVersion < 1
    || !Number.isSafeInteger(value.revocationEpoch)
    || value.revocationEpoch < 0
    || typeof value.issuedAt !== "string"
    || !value.issuedAt.endsWith("Z")
    || !Number.isFinite(new Date(value.issuedAt).getTime())
  ) {
    fail("Protected-compute version state fields are invalid.");
  }
  return Object.freeze({
    configIdentity: value.configIdentity,
    configVersion: value.configVersion,
    contract: CONTRACT,
    issuedAt: value.issuedAt,
    revocationEpoch: value.revocationEpoch,
    revokedCapabilities: validateList(
      value.revokedCapabilities,
      /^[a-z][a-z0-9.-]+(?:@\d+)?$/u,
      "revokedCapabilities",
    ),
    revokedKeyIds: validateList(
      value.revokedKeyIds,
      /^[A-Za-z0-9._:-]{1,128}$/u,
      "revokedKeyIds",
    ),
  });
}

function readRegularBounded(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (cause) {
    fail("Protected-compute version state cannot be read.", cause);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1
    || stat.size > MAX_STATE_BYTES
  ) {
    fail("Protected-compute version state is not a bounded regular file.");
  }
  return readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
}

function decodeState(filePath) {
  try {
    const plaintext = decryptSecret(readRegularBounded(filePath));
    if (!plaintext) fail("Protected-compute version state encryption is invalid.");
    return normalizeProtectedComputeVersionState(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof ProtectedComputeError) throw error;
    fail("Protected-compute version state authentication failed.", error);
  }
}

export function createProtectedComputeVersionStateStore({ filePath } = {}) {
  const targetPath = resolve(String(filePath || ""));
  if (!String(filePath || "").trim()) {
    fail("Protected-compute version state path is required.");
  }
  const backupPath = `${targetPath}.bak`;

  function load() {
    if (existsSync(targetPath)) {
      const state = decodeState(targetPath);
      if (existsSync(backupPath)) rmSync(backupPath, { force: true });
      return state;
    }
    if (!existsSync(backupPath)) return null;
    const recovered = decodeState(backupPath);
    renameSync(backupPath, targetPath);
    return recovered;
  }

  function save(value) {
    const state = normalizeProtectedComputeVersionState(value);
    mkdirSync(dirname(targetPath), { recursive: true });
    if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
      fail("Protected-compute version state target cannot be a symbolic link.");
    }
    if (existsSync(backupPath) && lstatSync(backupPath).isSymbolicLink()) {
      fail("Protected-compute version state backup cannot be a symbolic link.");
    }
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const encrypted = encryptSecret(JSON.stringify(state));
      if (!encrypted) fail("Protected-compute version state encryption failed.");
      writeFileSync(temporaryPath, `${encrypted}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      rmSync(backupPath, { force: true });
      if (existsSync(targetPath)) renameSync(targetPath, backupPath);
      try {
        renameSync(temporaryPath, targetPath);
      } catch (cause) {
        if (existsSync(backupPath) && !existsSync(targetPath)) {
          renameSync(backupPath, targetPath);
        }
        fail("Protected-compute version state atomic replacement failed.", cause);
      }
      rmSync(backupPath, { force: true });
      return state;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  return Object.freeze({
    filePath: targetPath,
    load,
    save,
  });
}

export const protectedComputeVersionStateContract = CONTRACT;

