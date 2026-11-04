import assert from "node:assert/strict";
import test from "node:test";
import {
  PROFILE_CACHE_MAINTENANCE_ARGUMENT,
  createProfileCacheMaintenanceRelaunchArgs,
  isProfileCacheMaintenanceRequested,
  scheduleProfileCacheMaintenanceRelaunch,
} from "./profileCacheMaintenanceLauncher.js";

test("maintenance relaunch arguments preserve the app entry and add one exact flag", () => {
  const argv = ["electron.exe", ".", "--inspect=0"];
  assert.deepEqual(
    createProfileCacheMaintenanceRelaunchArgs(argv, { maintenance: true }),
    [".", "--inspect=0", PROFILE_CACHE_MAINTENANCE_ARGUMENT],
  );
  assert.equal(isProfileCacheMaintenanceRequested(argv), false);
  assert.equal(
    isProfileCacheMaintenanceRequested([
      ...argv,
      PROFILE_CACHE_MAINTENANCE_ARGUMENT,
    ]),
    true,
  );
});

test("normal relaunch removes every maintenance flag without dropping unrelated arguments", () => {
  assert.deepEqual(
    createProfileCacheMaintenanceRelaunchArgs([
      "Wangzai.exe",
      PROFILE_CACHE_MAINTENANCE_ARGUMENT,
      "--profile=alpha",
      PROFILE_CACHE_MAINTENANCE_ARGUMENT,
    ]),
    ["--profile=alpha"],
  );
});

test("scheduler invokes Electron relaunch before the deferred quit", () => {
  const calls = [];
  const app = {
    relaunch(options) {
      calls.push(["relaunch", options]);
    },
    quit() {
      calls.push(["quit"]);
    },
  };
  let deferred = null;
  const result = scheduleProfileCacheMaintenanceRelaunch({
    app,
    argv: ["Wangzai.exe"],
    maintenance: true,
    schedule(callback, delay) {
      calls.push(["schedule", delay]);
      deferred = callback;
    },
  });
  assert.equal(result.scheduled, true);
  assert.deepEqual(calls, [
    ["relaunch", { args: [PROFILE_CACHE_MAINTENANCE_ARGUMENT] }],
    ["schedule", 100],
  ]);
  deferred();
  assert.deepEqual(calls.at(-1), ["quit"]);
});
