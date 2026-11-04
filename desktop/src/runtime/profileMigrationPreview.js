import fs from "node:fs";
import path from "node:path";

const MAX_SCANNED_FILES = 10_000;

function summarizeFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile()
      ? { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
      : { exists: false, bytes: 0, modifiedAt: null };
  } catch {
    return { exists: false, bytes: 0, modifiedAt: null };
  }
}

function summarizeDirectory(directoryPath) {
  const summary = { exists: false, files: 0, bytes: 0, truncated: false };
  if (!fs.existsSync(directoryPath)) return summary;
  summary.exists = true;
  const pending = [directoryPath];
  while (pending.length > 0 && summary.files < MAX_SCANNED_FILES) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (!entry.isFile()) continue;
      const stat = fs.statSync(entryPath);
      summary.files += 1;
      summary.bytes += stat.size;
      if (summary.files >= MAX_SCANNED_FILES) {
        summary.truncated = true;
        break;
      }
    }
  }
  return summary;
}

function candidate(id, { databasePath, jsonRoot, secretPath }) {
  return {
    id,
    database: summarizeFile(databasePath),
    wal: summarizeFile(`${databasePath}-wal`),
    shm: summarizeFile(`${databasePath}-shm`),
    json: summarizeDirectory(jsonRoot),
    secret: { exists: summarizeFile(secretPath).exists },
  };
}

/**
 * 只读迁移预览。它刻意不读取密钥内容、不打开 SQLite、不复制文件；真实合并必须
 * 在用户确认后由单独的迁移事务执行。
 */
export function createProfileMigrationPreview({ layout, workspaceRoot, localApiRoot }) {
  const canonical = candidate("canonical", {
    databasePath: layout.databasePath,
    jsonRoot: layout.localDataRoot,
    secretPath: layout.secretPath,
  });
  const workspace = candidate("legacy-workspace", {
    databasePath: path.join(localApiRoot, "data", "wangzai-local-api.sqlite"),
    jsonRoot: path.join(workspaceRoot, "本地数据"),
    secretPath: path.join(localApiRoot, "data", "local-api-secret.key"),
  });
  const legacyHasData = workspace.database.exists || workspace.json.files > 0;
  const canonicalHasData = canonical.database.exists || canonical.json.files > 0;
  const requiresDecision = legacyHasData && canonicalHasData;

  return Object.freeze({
    schemaVersion: 1,
    mode: requiresDecision ? "manual-decision-required" : legacyHasData ? "legacy-import-available" : "no-legacy-data",
    canonical,
    legacyCandidates: [workspace],
    confirmation: {
      required: legacyHasData,
      automaticCopyAllowed: false,
      reason: requiresDecision
        ? "canonical 与 legacy 都有数据，必须按 domain 差异确认后迁移"
        : legacyHasData
          ? "检测到 legacy 数据，必须先校验密钥和生成字段级差异"
          : "未检测到 legacy 数据",
    },
  });
}
