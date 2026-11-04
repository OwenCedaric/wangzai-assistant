export const PROFILE_CACHE_MAINTENANCE_ARGUMENT =
  "--profile-cache-maintenance";

export function isProfileCacheMaintenanceRequested(argv = process.argv) {
  return Array.isArray(argv)
    && argv.some((value) => String(value) === PROFILE_CACHE_MAINTENANCE_ARGUMENT);
}

/**
 * Electron app.relaunch() expects argv without the executable itself. Preserve
 * the development entry point and every unrelated argument, while making the
 * maintenance flag an exact, single-valued switch.
 */
export function createProfileCacheMaintenanceRelaunchArgs(
  argv = process.argv,
  { maintenance = false } = {},
) {
  const current = (Array.isArray(argv) ? argv : [])
    .slice(1)
    .map((value) => String(value))
    .filter((value) => value !== PROFILE_CACHE_MAINTENANCE_ARGUMENT);
  if (maintenance) current.push(PROFILE_CACHE_MAINTENANCE_ARGUMENT);
  return current;
}

export function scheduleProfileCacheMaintenanceRelaunch({
  app,
  argv = process.argv,
  maintenance,
  quitDelayMs = 100,
  schedule = setTimeout,
}) {
  if (!app || typeof app.relaunch !== "function" || typeof app.quit !== "function") {
    throw new Error("PROFILE_CACHE_MAINTENANCE_RELAUNCH_APP_REQUIRED");
  }
  const args = createProfileCacheMaintenanceRelaunchArgs(argv, { maintenance });
  app.relaunch({ args });
  schedule(() => app.quit(), quitDelayMs);
  return Object.freeze({
    ok: true,
    scheduled: true,
    maintenance: maintenance === true,
    args: Object.freeze([...args]),
  });
}
