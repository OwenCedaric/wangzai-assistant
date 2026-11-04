import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProtectedComputeVersionStateStore } from "./protectedComputeVersionState.js";

const STATE = Object.freeze({
  configIdentity: "a".repeat(64),
  configVersion: 8,
  contract: "protected-compute-version-state/v1",
  issuedAt: "2026-07-16T00:00:00.000Z",
  revocationEpoch: 5,
  revokedCapabilities: Object.freeze(["collection-pricing.quote@1"]),
  revokedKeyIds: Object.freeze(["retired-key-v0"]),
});

test("version high-water mark is authenticated, encrypted, atomic, and tamper-evident", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-version-state-"));
  const previousSecretFile = process.env.LOCAL_API_SECRET_FILE;
  try {
    process.env.LOCAL_API_SECRET_FILE = path.join(root, "local-api-secret.key");
    const statePath = path.join(root, "protected-compute-version-state.enc");
    const store = createProtectedComputeVersionStateStore({ filePath: statePath });
    assert.equal(store.load(), null);
    assert.deepEqual(store.save(STATE), STATE);
    assert.deepEqual(store.load(), STATE);
    const encrypted = fs.readFileSync(statePath, "utf8");
    assert.match(encrypted, /^secretbox:v1:/u);
    assert.doesNotMatch(encrypted, /collection-pricing|retired-key|configVersion/u);
    assert.equal(fs.existsSync(`${statePath}.bak`), false);

    const tamperedParts = encrypted.trim().split(":");
    tamperedParts[4] = `${tamperedParts[4][0] === "A" ? "B" : "A"}${tamperedParts[4].slice(1)}`;
    fs.writeFileSync(statePath, `${tamperedParts.join(":")}\n`, "utf8");
    assert.throws(
      () => store.load(),
      (error) => error?.code === "PROTECTED_COMPUTE_VERSION_STATE_INVALID"
        && error?.status === 503,
    );
  } finally {
    if (previousSecretFile === undefined) delete process.env.LOCAL_API_SECRET_FILE;
    else process.env.LOCAL_API_SECRET_FILE = previousSecretFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
