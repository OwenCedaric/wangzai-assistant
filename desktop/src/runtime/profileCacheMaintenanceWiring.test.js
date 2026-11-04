import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopSourceRoot = path.resolve(runtimeRoot, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(desktopSourceRoot, relativePath), "utf8");
}

test("main runs isolated cache maintenance before profile lock and services", () => {
  const main = read("main.js");
  const bootstrapStart = main.indexOf("async function bootstrapDesktop()");
  const maintenance = main.indexOf("runProfileCacheMaintenanceMode({", bootstrapStart);
  const profileLock = main.indexOf("paths.acquireCurrentProfileLock(profile)", bootstrapStart);
  const services = main.indexOf("services.startAll()", bootstrapStart);
  assert.ok(bootstrapStart >= 0);
  assert.ok(maintenance > bootstrapStart);
  assert.ok(profileLock > maintenance);
  assert.ok(services > profileLock);
  assert.match(main, /continueStartup !== false/u);
  assert.match(main, /restartRequired !== true/u);
});

test("renderer receives only a dedicated restart bridge, not cache filesystem access", () => {
  const preload = read("preload.cjs");
  const ipc = read("runtime/desktopIpc.js");
  assert.match(preload, /requestProfileCacheMaintenance:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('desktop:profile-cache-maintenance'\)/u);
  assert.match(ipc, /createProfileCacheMaintenanceIpcHandler/u);
  assert.match(ipc, /ACCOUNT_REMOVAL_PENDING/u);
  assert.match(ipc, /PROFILE_DATABASE_RECOVERY_REQUIRED/u);
  assert.doesNotMatch(preload, /profileCacheMaintenanceMode|applyProfileCacheMaintenance/u);
});
