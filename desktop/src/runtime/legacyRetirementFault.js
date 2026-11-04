const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SUPPORTED_MODES = new Set([
  "write-error",
  "readback-error",
  // The recovery evidence phase first preserves the browser value through a
  // real migration readback failure, then fails only the first restored
  // service start. The rollback start must stay real and able to succeed.
  "recovery-failure",
]);

function target(surface, writeMethod, writePath, readPath = writePath) {
  return Object.freeze({
    write: Object.freeze({ surface, method: writeMethod, path: writePath }),
    read: Object.freeze({ surface, method: "GET", path: readPath }),
  });
}

/**
 * One deliberately narrow canonical commit/readback pair per browser-retirement
 * fixture. These are test-only fault targets, not a production route registry.
 *
 * Multi-record migrations must point at their final durable commit. In
 * particular, a shop/account/asset precursor is allowed to succeed: otherwise
 * the failure phase would prove only that the precursor failed, rather than the
 * fixture's canonical migration target.
 */
export const LEGACY_RETIREMENT_CANONICAL_TARGETS = Object.freeze({
  "ozon-shop-settings": target(
    "local-api",
    "PUT",
    "/api/profile-settings/ozon-shop-preferences",
  ),
  // Marketing cache migration is an atomic SQLite import followed by an
  // independent public snapshot readback.  The old local-data JSON is input
  // only; targeting it here would let the retirement fixture prove a mirror
  // write instead of the canonical database commit.
  "marketing-activity-cache": target(
    "local-api",
    "POST",
    "/api/cache/marketing/legacy-import",
    "/api/cache/marketing",
  ),
  "product-material-profiles": target(
    "local-api",
    "POST",
    // The fixture has two profiles, so production migration takes the exact
    // typed bulk route. Faulting the normal single-save route would let this
    // test claim a write failure that never happened.
    "/api/products/material/legacy-import",
    "/api/products/material",
  ),
  "product-source-links": target(
    "local-api",
    "POST",
    "/api/products/source-links",
    "/api/products/source-links",
  ),
  "purchase-order-overrides": target(
    "local-api",
    "POST",
    "/api/purchase/orders/overrides",
  ),
  "purchase-source-links": target(
    "local-api",
    "POST",
    "/api/purchase/source-links",
  ),
  // The plugin context's current canonical store is the profile-settings
  // namespace. Its old local-data JSON is migration input only.
  "purchase-source-plugin-context": target(
    "local-api",
    "PUT",
    "/api/profile-settings/purchase-plugin-context",
  ),
  "sales-source-links": target(
    "local-api",
    "POST",
    "/api/sales/source-links",
  ),
});

function normalizedMethod(method) {
  return String(method || "GET").trim().toUpperCase();
}

function normalizedSurface(surface) {
  return String(surface || "").trim().toLowerCase();
}

function normalizedPath(path) {
  const rawPath = String(path || "").trim();
  const pathname = rawPath.split(/[?#]/u, 1)[0] || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function matchesRequest(request = {}, descriptor = null) {
  return Boolean(
    descriptor &&
      normalizedSurface(request.surface) === descriptor.surface &&
      normalizedMethod(request.method) === descriptor.method &&
      normalizedPath(request.path) === descriptor.path,
  );
}

/**
 * Isolated Electron-only failure controller for legacy-retirement evidence.
 * It is injected by main.js only when --legacy-retirement-test is present.
 */
export function createLegacyRetirementFault({
  enabled = false,
  phase = "",
  fixtureId = "",
  recoveryRemote = null,
} = {}) {
  const mode = enabled && SUPPORTED_MODES.has(String(phase).trim())
    ? String(phase).trim()
    : "";
  const canonicalTarget = mode
    ? LEGACY_RETIREMENT_CANONICAL_TARGETS[String(fixtureId || "").trim()] || null
    : null;
  const counts = {
    writeAttempted: 0,
    writeSucceeded: 0,
    writeRejected: 0,
    readAttempted: 0,
    readRejected: 0,
    targetWriteAttempted: 0,
    targetWriteSucceeded: 0,
    targetWriteRejected: 0,
    targetReadAttempted: 0,
    targetReadRejected: 0,
    recoveryActivationAttempted: 0,
    recoveryActivationRejected: 0,
    recoveryTargetWriteSucceeded: 0,
  };
  let recoveryCanonicalReadbackEnabled = false;
  const testRecoveryRemote = mode === "recovery-failure" &&
    typeof recoveryRemote === "object" &&
    String(recoveryRemote?.baseUrl || "").trim() &&
    String(recoveryRemote?.accessToken || "").trim()
    ? Object.freeze({
      baseUrl: String(recoveryRemote.baseUrl).trim(),
      accessToken: String(recoveryRemote.accessToken).trim(),
    })
    : null;

  function snapshot() {
    return {
      mode,
      targetConfigured: Boolean(canonicalTarget),
      ...counts,
      recoveryCanonicalReadbackEnabled,
    };
  }

  function beforeRequest(request = {}) {
    const normalized = normalizedMethod(request.method);
    if (!mode || !canonicalTarget) return null;

    const targetWrite = WRITE_METHODS.has(normalized) &&
      matchesRequest(request, canonicalTarget.write);
    if (WRITE_METHODS.has(normalized)) {
      counts.writeAttempted += 1;
      if (targetWrite) counts.targetWriteAttempted += 1;
      if (targetWrite && mode === "write-error") {
        counts.writeRejected += 1;
        counts.targetWriteRejected += 1;
        return {
          ok: false,
          status: 503,
          error: "LEGACY_RETIREMENT_WRITE_FAILURE",
        };
      }
      return null;
    }

    if (normalized === "GET") {
      counts.readAttempted += 1;
      const targetRead = matchesRequest(request, canonicalTarget.read);
      if (targetRead) counts.targetReadAttempted += 1;
      const shouldRejectReadback =
        targetRead &&
        counts.targetWriteSucceeded > 0 &&
        (
          mode === "readback-error" ||
          (mode === "recovery-failure" && !recoveryCanonicalReadbackEnabled)
        );
      if (shouldRejectReadback) {
        counts.readRejected += 1;
        counts.targetReadRejected += 1;
        return {
          ok: false,
          status: 503,
          error: "LEGACY_RETIREMENT_READBACK_FAILURE",
        };
      }
    }
    return null;
  }

  function recordResult(request = {}) {
    const normalized = normalizedMethod(request.method);
    if (!mode || !WRITE_METHODS.has(normalized) || request.result?.ok !== true) return;

    counts.writeSucceeded += 1;
    if (!canonicalTarget || !matchesRequest(request, canonicalTarget.write)) return;

    counts.targetWriteSucceeded += 1;
    if (mode === "recovery-failure") counts.recoveryTargetWriteSucceeded += 1;
  }

  function beforeRecoveryActivationStart() {
    if (mode !== "recovery-failure") return null;
    counts.recoveryActivationAttempted += 1;
    if (counts.recoveryActivationRejected > 0) return null;
    counts.recoveryActivationRejected += 1;
    return "LEGACY_RETIREMENT_RECOVERY_ACTIVATION_FAILURE";
  }

  function getRecoveryTestRemote() {
    return testRecoveryRemote;
  }

  function completeRecoveryActivation() {
    if (mode === "recovery-failure") recoveryCanonicalReadbackEnabled = true;
  }

  return Object.freeze({
    beforeRequest,
    recordResult,
    beforeRecoveryActivationStart,
    getRecoveryTestRemote,
    completeRecoveryActivation,
    snapshot,
  });
}
