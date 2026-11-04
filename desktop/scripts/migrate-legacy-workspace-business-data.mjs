import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacyWorkspaceBusinessData } from "../src/runtime/legacyWorkspaceBusinessMigration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const defaultDataRoot = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  "wangzai-desktop",
);

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const dataRoot = path.resolve(readArgument("data-root", defaultDataRoot));
const sourceDatabasePath = path.resolve(
  readArgument(
    "source",
    path.join(workspaceRoot, "local-api", "data", "wangzai-local-api.sqlite"),
  ),
);
const targetDatabasePath = path.resolve(
  readArgument(
    "target",
    path.join(dataRoot, "local-api-data", "wangzai-local-api.sqlite"),
  ),
);

try {
  const result = migrateLegacyWorkspaceBusinessData({
    sourceDatabasePath,
    targetDatabasePath,
    markerPath: path.join(
      dataRoot,
      "runtime",
      "legacy-workspace-business-v1.json",
    ),
    backupDirectory: path.join(dataRoot, "backups"),
    apply,
    force,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error?.message || String(error),
        backupPath: error?.backupPath || "",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
