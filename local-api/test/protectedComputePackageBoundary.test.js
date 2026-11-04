import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanProtectedComputePackagingBoundary } from "../src/domain/protectedCompute/packageBoundaryAudit.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "protected-compute-boundary-"));
  const server = path.join(root, "server-core");
  const client = path.join(root, "client");
  await mkdir(server);
  await mkdir(client);
  await writeFile(
    path.join(server, "formula.py"),
    [
      "# PROTECTED_CORE_ONLY::fixture.formula@1",
      "_POLICY_FIXTURE_COEFFICIENT = 137",
      "def compute(value): return value * _POLICY_FIXTURE_COEFFICIENT",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(client, "public-contract.js"), "export const version = 1;", "utf8");
  return { client, root, server };
}

test("package-boundary audit accepts public contracts without server core or private keys", async () => {
  const paths = await fixture();
  try {
    const result = await scanProtectedComputePackagingBoundary({
      clientRoots: [paths.client],
      serverCoreRoot: paths.server,
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("package-boundary audit rejects core markers, policy symbols, copies, and private keys", async () => {
  const paths = await fixture();
  try {
    await writeFile(
      path.join(paths.client, "leak.txt"),
      [
        "PROTECTED_CORE_ONLY::fixture.formula@1",
        "_POLICY_FIXTURE_COEFFICIENT",
        "-----BEGIN PRIVATE KEY-----",
        "eyJ0123456789abcdef.abcdefghijklmnop.qrstuvwxyzABCDEF",
      ].join("\n"),
      "utf8",
    );
    const result = await scanProtectedComputePackagingBoundary({
      clientRoots: [paths.client],
      serverCoreRoot: paths.server,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      new Set(result.findings.map((item) => item.code)),
      new Set([
        "PROTECTED_COMPUTE_CORE_MARKER_LEAK",
        "PROTECTED_COMPUTE_CORE_SYMBOL_LEAK",
        "PROTECTED_COMPUTE_PRIVATE_KEY_LEAK",
        "PROTECTED_COMPUTE_LONG_TOKEN_LEAK",
      ]),
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
