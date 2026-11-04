import {
  createHash,
  createPublicKey,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

import { canonicalJson } from "./canonicalJson.js";
import { createProtectedComputeClientFromSignedConfig } from "./protectedComputeRuntimeConfig.js";
import { ProtectedComputeError } from "./protectedComputeError.js";
import { createStaticProtectedComputeTrustStore } from "./protectedComputeTrustStore.js";
import { createProtectedComputeVersionStateStore } from "./protectedComputeVersionState.js";
import { createPaidCapabilityClient } from "../paidCapabilities/paidCapabilityClient.js";

const MAX_SIGNED_CONFIG_BYTES = 256 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

function readBoundedText(filePath, maximumBytes, code) {
  const stat = lstatSync(filePath);
  const size = stat.size;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !Number.isSafeInteger(size)
    || size < 1
    || size > maximumBytes
  ) {
    throw new ProtectedComputeError(code, "Protected-compute public runtime file is invalid.", {
      status: 503,
    });
  }
  return readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
}

function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_KEY_INVALID",
      "Protected-compute configuration trust key must use Ed25519.",
      { status: 503 },
    );
  }
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRuntimeError(error, fallbackCode = "PROTECTED_COMPUTE_RUNTIME_CONFIG_INVALID") {
  const code = typeof error?.code === "string" && error.code.startsWith("PROTECTED_COMPUTE_")
    ? error.code
    : fallbackCode;
  if (error instanceof ProtectedComputeError && error.status === 503) return error;
  return new ProtectedComputeError(
    code,
    error instanceof Error
      ? error.message
      : "Protected-compute public runtime configuration is invalid.",
    { cause: error, status: 503, retriable: false },
  );
}

function parseSignedPublicConfig(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      "Signed-public protected-compute configuration is not valid JSON.",
      { cause, status: 503, retriable: false },
    );
  }
}

function assertFiniteNow(clock) {
  const value = new Date(clock()).getTime();
  if (!Number.isFinite(value)) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RUNTIME_CLOCK_INVALID",
      "Protected-compute runtime clock is invalid.",
      { status: 503, retriable: false },
    );
  }
  return value;
}

function assertGenerationIsCurrent(generation, clock) {
  if (!generation) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED",
      "Protected compute is not configured on this local runtime.",
      { status: 503, retriable: false },
    );
  }
  if (new Date(generation.client.config.expiresAt).getTime() <= assertFiniteNow(clock)) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_EXPIRED",
      "Signed-public protected-compute configuration has expired.",
      { status: 503, retriable: false },
    );
  }
  return generation;
}

function isSubset(previous, next) {
  const nextValues = new Set(next);
  return previous.every((value) => nextValues.has(value));
}

function assertForwardRotation(previous, candidate) {
  if (!previous || previous.identity === candidate.identity) return;
  const previousConfig = previous.client.config;
  const candidateConfig = candidate.client.config;
  if (
    candidateConfig.configVersion <= previousConfig.configVersion
    || new Date(candidateConfig.issuedAt).getTime()
      < new Date(previousConfig.issuedAt).getTime()
    || candidateConfig.revocationEpoch < previousConfig.revocationEpoch
    || !isSubset(
      previousConfig.revocationState.revokedCapabilities,
      candidateConfig.revocationState.revokedCapabilities,
    )
    || !isSubset(
      previousConfig.revocationState.revokedKeyIds,
      candidateConfig.revocationState.revokedKeyIds,
    )
  ) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED",
      "Signed-public protected-compute configuration rotation would roll back trust or revocation state.",
      { status: 503, retriable: false },
    );
  }
}

function versionStateForGeneration(generation) {
  const config = generation.client.config;
  return Object.freeze({
    configIdentity: generation.identity,
    configVersion: config.configVersion,
    contract: "protected-compute-version-state/v1",
    issuedAt: config.issuedAt,
    revocationEpoch: config.revocationEpoch,
    revokedCapabilities: Object.freeze([
      ...config.revocationState.revokedCapabilities,
    ]),
    revokedKeyIds: Object.freeze([
      ...config.revocationState.revokedKeyIds,
    ]),
  });
}

function assertForwardFromPersistedState(previous, candidate) {
  if (!previous) return;
  const next = versionStateForGeneration(candidate);
  if (
    next.configVersion < previous.configVersion
    || (
      next.configVersion === previous.configVersion
      && next.configIdentity !== previous.configIdentity
    )
    || new Date(next.issuedAt).getTime() < new Date(previous.issuedAt).getTime()
    || next.revocationEpoch < previous.revocationEpoch
    || !isSubset(previous.revokedCapabilities, next.revokedCapabilities)
    || !isSubset(previous.revokedKeyIds, next.revokedKeyIds)
  ) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_ROLLBACK_REJECTED",
      "Signed-public protected-compute configuration is older than the authenticated persistent high-water mark.",
      { status: 503, retriable: false },
    );
  }
}

function disabledRuntime(reasonCode) {
  return Object.freeze({
    client: null,
    status: Object.freeze({
      available: false,
      configured: false,
      configVersion: null,
      configExpiresAt: null,
      offlineEnabled: false,
      reasonCode,
    }),
  });
}

export function createProtectedComputeRuntimeFromConfig(
  config = {},
  {
    fetchImpl = globalThis.fetch,
    now,
    signedResultStore,
    replayGuard,
    versionStateStore,
  } = {},
) {
  const signedPublicConfigPath = String(config.signedPublicConfigPath || "").trim();
  const configurationPublicKeyPath = String(config.configurationPublicKeyPath || "").trim();
  const configurationKeyId = String(config.configurationKeyId || "").trim();
  const expectedFingerprint = String(config.configurationKeySha256 || "").trim().toLowerCase();
  const versionStatePath = String(config.versionStatePath || "").trim();
  const configuredValues = [
    signedPublicConfigPath,
    configurationPublicKeyPath,
    configurationKeyId,
    expectedFingerprint,
  ];
  if (configuredValues.every((value) => !value)) {
    return disabledRuntime("PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED");
  }
  if (
    configuredValues.some((value) => !value)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(configurationKeyId)
    || !/^[a-f0-9]{64}$/u.test(expectedFingerprint)
  ) {
    return disabledRuntime("PROTECTED_COMPUTE_RUNTIME_CONFIG_INCOMPLETE");
  }

  try {
    const publicKeyPem = readBoundedText(
      configurationPublicKeyPath,
      MAX_PUBLIC_KEY_BYTES,
      "PROTECTED_COMPUTE_CONFIG_KEY_INVALID",
    );
    if (publicKeyFingerprint(publicKeyPem) !== expectedFingerprint) {
      throw new ProtectedComputeError(
        "PROTECTED_COMPUTE_CONFIG_KEY_FINGERPRINT_MISMATCH",
        "Protected-compute configuration trust-key fingerprint does not match.",
        { status: 503 },
      );
    }
    const configTrustStore = createStaticProtectedComputeTrustStore({
      keys: { [configurationKeyId]: publicKeyPem },
    });
    const clock = typeof now === "function" ? now : () => new Date();
    const localUserSettings = Object.freeze({
      // Offline reuse is deliberately disabled in the default composition
      // root. Enabling it requires an explicitly injected approved store.
      offlineEnabled: Boolean(config.offlineEnabled && signedResultStore),
      sourceClass: "local-user",
    });
    const persistentVersionStateStore = versionStateStore || (
      versionStatePath
        ? createProtectedComputeVersionStateStore({ filePath: versionStatePath })
        : null
    );
    let persistentVersionState = persistentVersionStateStore?.load?.() || null;
    let activeGeneration = null;
    let lastError = null;

    function readCandidate() {
      const text = readBoundedText(
        signedPublicConfigPath,
        MAX_SIGNED_CONFIG_BYTES,
        "PROTECTED_COMPUTE_CONFIG_INVALID",
      );
      const rawHash = sha256(text);
      if (activeGeneration?.rawHash === rawHash) return activeGeneration;

      const signedPublicConfig = parseSignedPublicConfig(text);
      const identity = sha256(canonicalJson(signedPublicConfig));
      if (activeGeneration?.identity === identity) {
        return Object.freeze({ ...activeGeneration, rawHash });
      }
      const client = createProtectedComputeClientFromSignedConfig({
        signedPublicConfig,
        configTrustStore,
        localUserSettings,
        accessTokenProvider: async () => "",
        fetchImpl,
        now: clock,
        ...(signedResultStore ? { signedResultStore } : {}),
        ...(replayGuard ? { replayGuard } : {}),
      });
      const paidClient = createPaidCapabilityClient({
        baseUrl: client.config.serverBaseUrl,
        trustStore: client.config.trustStore,
        fetchImpl,
        now: clock,
      });
      return Object.freeze({ client, paidClient, identity, rawHash });
    }

    function reloadGeneration() {
      try {
        const candidate = readCandidate();
        assertForwardRotation(activeGeneration, candidate);
        assertForwardFromPersistedState(persistentVersionState, candidate);
        const currentCandidate = assertGenerationIsCurrent(candidate, clock);
        const nextVersionState = versionStateForGeneration(currentCandidate);
        if (
          persistentVersionStateStore
          && (
            !persistentVersionState
            || persistentVersionState.configIdentity !== nextVersionState.configIdentity
          )
        ) {
          persistentVersionState = persistentVersionStateStore.save(nextVersionState);
        }
        activeGeneration = currentCandidate;
        lastError = null;
        return activeGeneration;
      } catch (error) {
        lastError = normalizeRuntimeError(error);
        throw lastError;
      }
    }

    function statusFor(generation, error = null) {
      const client = generation?.client;
      return Object.freeze({
        available: Boolean(client) && !error,
        configured: Boolean(client),
        configVersion: Number.isSafeInteger(client?.config?.configVersion)
          ? client.config.configVersion
          : null,
        configExpiresAt: typeof client?.config?.expiresAt === "string"
          ? client.config.expiresAt
          : null,
        offlineEnabled: Boolean(client) && !error && client.userSettings.offlineEnabled,
        reasonCode: error?.code || (client ? null : "PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED"),
      });
    }

    function getStatus() {
      try {
        return statusFor(reloadGeneration());
      } catch {
        return statusFor(activeGeneration, lastError);
      }
    }

    function reloadSignedPublicConfig() {
      return statusFor(reloadGeneration());
    }

    const client = Object.freeze({
      async execute(request, options = {}) {
        const generation = reloadGeneration();
        const verified = await generation.client.execute(request, options);
        const currentGeneration = reloadGeneration();
        if (currentGeneration.identity !== generation.identity) {
          throw new ProtectedComputeError(
            "PROTECTED_COMPUTE_CONFIG_CHANGED",
            "Signed-public protected-compute configuration changed during execution; retry is required.",
            { status: 503, retriable: true },
          );
        }
        return verified;
      },
      async executePaid(request, options = {}) {
        const generation = reloadGeneration();
        const verified = await generation.paidClient.execute(request, options);
        const currentGeneration = reloadGeneration();
        if (currentGeneration.identity !== generation.identity) {
          throw new ProtectedComputeError(
            "PROTECTED_COMPUTE_CONFIG_CHANGED",
            "Signed-public protected-compute configuration changed during execution; retry is required.",
            { status: 503, retriable: true },
          );
        }
        return verified;
      },
    });

    // Bootstrap must succeed once. After that, every status read and execution
    // re-reads the bounded signed file, enforces expiry, and permits only a
    // forward, signature-verified rotation under the pinned configuration key.
    reloadGeneration();
    return Object.freeze({
      client,
      get status() {
        return getStatus();
      },
      getStatus,
      reloadSignedPublicConfig,
    });
  } catch (error) {
    return disabledRuntime(
      typeof error?.code === "string" && error.code.startsWith("PROTECTED_COMPUTE_")
        ? error.code
        : "PROTECTED_COMPUTE_RUNTIME_CONFIG_INVALID",
    );
  }
}
