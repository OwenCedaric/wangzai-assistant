import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataLayout } from "./dataLayout.js";
import { createProfileMigrationPreview } from "./profileMigrationPreview.js";

test("migration preview detects two data worlds without touching either one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-preview-"));
  try {
    const layout = resolveDataLayout({ dataRoot: path.join(root, "canonical") });
    const workspaceRoot = path.join(root, "workspace");
    const localApiRoot = path.join(workspaceRoot, "local-api");
    fs.mkdirSync(path.dirname(layout.databasePath), { recursive: true });
    fs.writeFileSync(layout.databasePath, "canonical-db");
    fs.mkdirSync(path.join(localApiRoot, "data"), { recursive: true });
    fs.writeFileSync(path.join(localApiRoot, "data", "wangzai-local-api.sqlite"), "legacy-db");
    fs.mkdirSync(path.join(workspaceRoot, "本地数据"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "本地数据", "settings.json"), "{}");

    const preview = createProfileMigrationPreview({ layout, workspaceRoot, localApiRoot });
    assert.equal(preview.mode, "manual-decision-required");
    assert.equal(preview.canonical.database.exists, true);
    assert.equal(preview.legacyCandidates[0].database.exists, true);
    assert.equal(preview.legacyCandidates[0].json.files, 1);
    assert.equal(preview.confirmation.automaticCopyAllowed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
