import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProfileCacheMaintenance,
  inspectProfileCacheMaintenance,
} from "../src/runtime/profileCacheMaintenance.js";
import { PROFILE_MAINTENANCE_COMMANDS } from "../src/runtime/profileCachePolicy.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function defaultDataRoot() {
  const configured = String(process.env.WANGZAI_DESKTOP_DATA_DIR || "").trim();
  if (configured) return configured;
  const appData = String(process.env.APPDATA || "").trim();
  if (appData) return path.join(appData, "wangzai-desktop");
  return path.join(os.homedir(), "AppData", "Roaming", "wangzai-desktop");
}

const dataRoot = path.resolve(readArgument("data-root", defaultDataRoot()));
const selectedWorkspaceRoot = path.resolve(readArgument("workspace-root", workspaceRoot));
const databasePath = path.resolve(
  readArgument(
    "database",
    path.join(dataRoot, "local-api-data", "wangzai-local-api.sqlite"),
  ),
);
const options = {
  command: readArgument(
    "command",
    PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE,
  ),
  dataRoot,
  workspaceRoot: selectedWorkspaceRoot,
  databasePath,
};

const result = hasFlag("apply")
  ? applyProfileCacheMaintenance({
      ...options,
      confirmation: readArgument("confirmation"),
      previewToken: readArgument("preview-token"),
    })
  : inspectProfileCacheMaintenance(options);

console.log(JSON.stringify(result, null, 2));
