import assert from "node:assert/strict";
import test from "node:test";
import {
  createLegacyRetirementFault,
  LEGACY_RETIREMENT_CANONICAL_TARGETS,
} from "./legacyRetirementFault.js";

function requestFor(fixtureId, kind, overrides = {}) {
  return {
    ...LEGACY_RETIREMENT_CANONICAL_TARGETS[fixtureId][kind],
    ...overrides,
  };
}

function recordSuccessfulWrite(fault, request) {
  assert.equal(fault.beforeRequest(request), null);
  fault.recordResult({ ...request, result: { ok: true } });
}

test("legacy retirement fault stays disabled outside isolated Electron phases", () => {
  const fault = createLegacyRetirementFault({
    enabled: false,
    phase: "write-error",
    fixtureId: "product-material-profiles",
  });
  assert.equal(fault.beforeRequest(requestFor("product-material-profiles", "write")), null);
  assert.deepEqual(fault.snapshot(), {
    mode: "",
    targetConfigured: false,
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
    recoveryCanonicalReadbackEnabled: false,
  });
});

test("canonical target registry tracks each current fixture's final durable commit", () => {
  assert.deepEqual(LEGACY_RETIREMENT_CANONICAL_TARGETS, {
    "ozon-shop-settings": {
      write: { surface: "local-api", method: "PUT", path: "/api/profile-settings/ozon-shop-preferences" },
      read: { surface: "local-api", method: "GET", path: "/api/profile-settings/ozon-shop-preferences" },
    },
    "marketing-activity-cache": {
      write: { surface: "local-api", method: "POST", path: "/api/cache/marketing/legacy-import" },
      read: { surface: "local-api", method: "GET", path: "/api/cache/marketing" },
    },
    "product-material-profiles": {
      write: { surface: "local-api", method: "POST", path: "/api/products/material/legacy-import" },
      read: { surface: "local-api", method: "GET", path: "/api/products/material" },
    },
    "product-source-links": {
      write: { surface: "local-api", method: "POST", path: "/api/products/source-links" },
      read: { surface: "local-api", method: "GET", path: "/api/products/source-links" },
    },
    "purchase-order-overrides": {
      write: { surface: "local-api", method: "POST", path: "/api/purchase/orders/overrides" },
      read: { surface: "local-api", method: "GET", path: "/api/purchase/orders/overrides" },
    },
    "purchase-source-links": {
      write: { surface: "local-api", method: "POST", path: "/api/purchase/source-links" },
      read: { surface: "local-api", method: "GET", path: "/api/purchase/source-links" },
    },
    "purchase-source-plugin-context": {
      write: { surface: "local-api", method: "PUT", path: "/api/profile-settings/purchase-plugin-context" },
      read: { surface: "local-api", method: "GET", path: "/api/profile-settings/purchase-plugin-context" },
    },
    "sales-source-links": {
      write: { surface: "local-api", method: "POST", path: "/api/sales/source-links" },
      read: { surface: "local-api", method: "GET", path: "/api/sales/source-links" },
    },
  });
});

test("write-error rejects only the fixture's final canonical write, not Ozon precursor writes", () => {
  const fault = createLegacyRetirementFault({
    enabled: true,
    phase: "write-error",
    fixtureId: "ozon-shop-settings",
  });
  const precursor = { surface: "local-api", method: "POST", path: "/api/shops" };

  recordSuccessfulWrite(fault, precursor);
  assert.equal(
    fault.beforeRequest({
      surface: "local-api",
      method: "PUT",
      path: "/api/profile-settings/ozon-shop-preferences/unrelated",
    }),
    null,
  );
  assert.deepEqual(
    fault.beforeRequest({
      ...requestFor("ozon-shop-settings", "write"),
      path: "/api/profile-settings/ozon-shop-preferences?fixture=1",
    }),
    {
      ok: false,
      status: 503,
      error: "LEGACY_RETIREMENT_WRITE_FAILURE",
    },
  );

  const snapshot = fault.snapshot();
  assert.equal(snapshot.writeSucceeded, 1);
  assert.equal(snapshot.targetWriteAttempted, 1);
  assert.equal(snapshot.targetWriteRejected, 1);
  assert.equal(snapshot.targetWriteSucceeded, 0);
});

test("readback-error arms only after its target write, not an unrelated precursor", () => {
  const fault = createLegacyRetirementFault({
    enabled: true,
    phase: "readback-error",
    fixtureId: "product-material-profiles",
  });
  const precursor = {
    surface: "local-api",
    method: "POST",
    path: "/api/products/material",
  };

  recordSuccessfulWrite(fault, precursor);
  assert.equal(fault.beforeRequest(requestFor("product-material-profiles", "read")), null);
  assert.equal(fault.beforeRequest({ surface: "local-api", method: "GET", path: "/api/products/material/other" }), null);

  recordSuccessfulWrite(fault, requestFor("product-material-profiles", "write"));
  assert.deepEqual(
    fault.beforeRequest({
      ...requestFor("product-material-profiles", "read"),
      path: "/api/products/material?readback=1",
    }),
    {
      ok: false,
      status: 503,
      error: "LEGACY_RETIREMENT_READBACK_FAILURE",
    },
  );

  const snapshot = fault.snapshot();
  assert.equal(snapshot.targetWriteSucceeded, 1);
  assert.equal(snapshot.targetReadRejected, 1);
  assert.equal(snapshot.readRejected, 1);
});

test("every configured fixture injects write/readback failures only at its exact canonical pair", () => {
  for (const fixtureId of Object.keys(LEGACY_RETIREMENT_CANONICAL_TARGETS)) {
    const writeFault = createLegacyRetirementFault({
      enabled: true,
      phase: "write-error",
      fixtureId,
    });
    assert.deepEqual(
      writeFault.beforeRequest(requestFor(fixtureId, "write")),
      {
        ok: false,
        status: 503,
        error: "LEGACY_RETIREMENT_WRITE_FAILURE",
      },
      fixtureId,
    );
    assert.equal(writeFault.snapshot().targetWriteRejected, 1, fixtureId);

    const readFault = createLegacyRetirementFault({
      enabled: true,
      phase: "readback-error",
      fixtureId,
    });
    recordSuccessfulWrite(readFault, requestFor(fixtureId, "write"));
    assert.deepEqual(
      readFault.beforeRequest(requestFor(fixtureId, "read")),
      {
        ok: false,
        status: 503,
        error: "LEGACY_RETIREMENT_READBACK_FAILURE",
      },
      fixtureId,
    );
    assert.equal(readFault.snapshot().targetReadRejected, 1, fixtureId);
  }
});

test("exact target matching does not accept a route prefix or a different request surface", () => {
  const fault = createLegacyRetirementFault({
    enabled: true,
    phase: "write-error",
    fixtureId: "product-material-profiles",
  });
  assert.equal(
    fault.beforeRequest({
      surface: "local-api",
      method: "POST",
      path: "/api/products/material/extra",
    }),
    null,
  );
  assert.equal(
    fault.beforeRequest({
      surface: "local-data",
      method: "POST",
      path: "/api/products/material",
    }),
    null,
  );
  assert.equal(fault.snapshot().targetWriteAttempted, 0);
});

test("unknown fixture fails closed instead of falling back to a global fault", () => {
  const fault = createLegacyRetirementFault({
    enabled: true,
    phase: "write-error",
    fixtureId: "not-a-fixture",
  });
  assert.equal(fault.beforeRequest({ surface: "local-api", method: "POST", path: "/api/shops" }), null);
  assert.equal(fault.beforeRequest({ surface: "local-api", method: "POST", path: "/api/shops" }), null);
  assert.equal(fault.snapshot().targetConfigured, false);
  assert.equal(fault.snapshot().writeRejected, 0);
});

test("recovery-failure waits for its target write and permits canonical readback only after activation", () => {
  const fault = createLegacyRetirementFault({
    enabled: true,
    phase: "recovery-failure",
    fixtureId: "product-material-profiles",
  });
  const precursor = { surface: "local-api", method: "GET", path: "/api/shops" };

  recordSuccessfulWrite(fault, precursor);
  assert.equal(fault.beforeRequest(requestFor("product-material-profiles", "read")), null);

  recordSuccessfulWrite(fault, requestFor("product-material-profiles", "write"));
  assert.deepEqual(fault.beforeRequest(requestFor("product-material-profiles", "read")), {
    ok: false,
    status: 503,
    error: "LEGACY_RETIREMENT_READBACK_FAILURE",
  });
  assert.equal(fault.beforeRecoveryActivationStart(), "LEGACY_RETIREMENT_RECOVERY_ACTIVATION_FAILURE");
  assert.equal(fault.beforeRecoveryActivationStart(), null);
  fault.completeRecoveryActivation();
  assert.equal(fault.beforeRequest(requestFor("product-material-profiles", "read")), null);

  const snapshot = fault.snapshot();
  assert.equal(snapshot.targetConfigured, true);
  assert.equal(snapshot.targetWriteSucceeded, 1);
  assert.equal(snapshot.targetReadRejected, 1);
  assert.equal(snapshot.recoveryTargetWriteSucceeded, 1);
  assert.equal(snapshot.recoveryCanonicalReadbackEnabled, true);
});

test("recovery test remote is available only inside the isolated recovery-failure phase", () => {
  const remote = { baseUrl: "http://127.0.0.1:49152", accessToken: "isolated-recovery-token" };
  assert.deepEqual(
    createLegacyRetirementFault({
      enabled: true,
      phase: "recovery-failure",
      fixtureId: "product-material-profiles",
      recoveryRemote: remote,
    }).getRecoveryTestRemote(),
    remote,
  );
  assert.equal(
    createLegacyRetirementFault({
      enabled: true,
      phase: "readback-error",
      fixtureId: "product-material-profiles",
      recoveryRemote: remote,
    }).getRecoveryTestRemote(),
    null,
  );
});
