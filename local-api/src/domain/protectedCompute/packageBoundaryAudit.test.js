import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanProtectedComputePackagingBoundary } from "./packageBoundaryAudit.js";

test("package artifact scan includes normally ignored node_modules directories", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "protected-compute-package-boundary-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serverCoreRoot = path.join(directory, "server-core");
  const clientRoot = path.join(directory, "resources");
  await fs.mkdir(serverCoreRoot, { recursive: true });
  await fs.mkdir(path.join(clientRoot, "node_modules", "fixture-package"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(serverCoreRoot, "policy.py"),
    "# PROTECTED_CORE_ONLY::fixture@1\n_POLICY_FIXTURE_VALUE = 1\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(clientRoot, "node_modules", "fixture-package", "leak.js"),
    "export const marker = 'PROTECTED_CORE_ONLY::fixture@1';\n",
    "utf8",
  );

  const result = await scanProtectedComputePackagingBoundary({
    clientRoots: [clientRoot],
    serverCoreRoot,
    includeIgnoredDirectories: true,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "PROTECTED_COMPUTE_CORE_MARKER_LEAK",
    ),
    true,
  );
});
