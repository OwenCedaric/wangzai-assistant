import { verify } from "node:crypto";

import { canonicalJson } from "./canonicalJson.js";
import { createProtectedComputeClient } from "./protectedComputeClient.js";
import {
  ProtectedComputeError,
  protectedComputeContractError,
} from "./protectedComputeError.js";
import { createStaticProtectedComputeTrustStore } from "./protectedComputeTrustStore.js";

const SIGNED_CONFIG_FIELDS = Object.freeze([
  "computeKeys",
  "configVersion",
  "contract",
  "expiresAt",
  "issuedAt",
  "revocationEpoch",
  "revokedCapabilities",
  "revokedKeyIds",
  "serverBaseUrl",
  "signature",
  "signatureAlgorithm",
  "signingKeyId",
]);
const COMPUTE_KEY_FIELDS = Object.freeze([
  "algorithm",
  "keyId",
  "publicKeyPem",
]);
const LOCAL_USER_FIELDS = Object.freeze(["offlineEnabled", "sourceClass"]);

function exactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      `${label} must be an object.`,
    );
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      `${label} contains unsupported or missing fields.`,
    );
  }
}

function timestamp(value, field) {
  const result = new Date(value).getTime();
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(result)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      `${field} is invalid.`,
    );
  }
  return result;
}

export function verifySignedPublicProtectedComputeConfig(
  envelope,
  { configTrustStore, now = () => new Date(), maxLifetimeMs = 31_536_000_000 } = {},
) {
  exactFields(envelope, SIGNED_CONFIG_FIELDS, "Signed-public config");
  if (
    envelope.contract !== "signed-public-protected-compute-config/v1" ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    !Number.isSafeInteger(envelope.configVersion) ||
    envelope.configVersion < 1 ||
    !Number.isSafeInteger(envelope.revocationEpoch) ||
    envelope.revocationEpoch < 0 ||
    !Array.isArray(envelope.computeKeys) ||
    !envelope.computeKeys.length ||
    !Array.isArray(envelope.revokedCapabilities) ||
    !Array.isArray(envelope.revokedKeyIds) ||
    envelope.revokedCapabilities.some(
      (value) =>
        typeof value !== "string" ||
        !/^[a-z][a-z0-9.-]+(?:@\d+)?$/u.test(value),
    ) ||
    envelope.revokedKeyIds.some(
      (value) =>
        typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value),
    ) ||
    new Set(envelope.revokedCapabilities).size !==
      envelope.revokedCapabilities.length ||
    new Set(envelope.revokedKeyIds).size !== envelope.revokedKeyIds.length ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(envelope.signingKeyId || "") ||
    !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature || "")
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      "Signed-public protected-compute config is invalid.",
    );
  }
  try {
    const serverUrl = new URL(envelope.serverBaseUrl);
    if (
      serverUrl.protocol !== "https:" ||
      serverUrl.username ||
      serverUrl.password ||
      serverUrl.search ||
      serverUrl.hash
    ) {
      throw new Error("unsafe URL");
    }
  } catch {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CONFIG_INVALID",
      "Signed-public protected-compute server URL is unsafe.",
    );
  }
  const issuedAtMs = timestamp(envelope.issuedAt, "issuedAt");
  const expiresAtMs = timestamp(envelope.expiresAt, "expiresAt");
  const nowMs = new Date(now()).getTime();
  if (
    issuedAtMs > nowMs + 60_000 ||
    expiresAtMs <= nowMs ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > maxLifetimeMs
  ) {
    throw new ProtectedComputeError(
      expiresAtMs <= nowMs
        ? "PROTECTED_COMPUTE_CONFIG_EXPIRED"
        : "PROTECTED_COMPUTE_CONFIG_INVALID",
      "Signed-public protected-compute config is expired or has an invalid window.",
      { status: 503 },
    );
  }
  const configurationKey = configTrustStore?.getPublicKey?.(
    envelope.signingKeyId,
  );
  if (!configurationKey) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_KEY_UNTRUSTED",
      "Signed-public config uses an untrusted configuration key.",
      { status: 503 },
    );
  }
  const { signature, ...signedPayload } = envelope;
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(signedPayload)),
      configurationKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_CONFIG_SIGNATURE_INVALID",
      "Signed-public protected-compute config signature is invalid.",
      { status: 503 },
    );
  }
  const keys = {};
  for (const item of envelope.computeKeys) {
    exactFields(item, COMPUTE_KEY_FIELDS, "Protected-compute public key");
    if (
      item.algorithm !== "Ed25519" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.keyId || "") ||
      Object.hasOwn(keys, item.keyId)
    ) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_CONFIG_INVALID",
        "Signed-public config contains an invalid compute key.",
      );
    }
    keys[item.keyId] = item.publicKeyPem;
  }
  const trustStore = createStaticProtectedComputeTrustStore({ keys });
  return Object.freeze({
    configVersion: envelope.configVersion,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    revocationEpoch: envelope.revocationEpoch,
    revocationState: Object.freeze({
      minimumEpoch: envelope.revocationEpoch,
      revokedCapabilities: Object.freeze([...envelope.revokedCapabilities]),
      revokedKeyIds: Object.freeze([...envelope.revokedKeyIds]),
    }),
    serverBaseUrl: envelope.serverBaseUrl,
    signatureVerified: true,
    sourceClass: "signed-public",
    trustStore,
  });
}

export function normalizeProtectedComputeLocalUserSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_USER_SETTINGS_INVALID",
      "Protected-compute user settings must be a local-user object.",
    );
  }
  let keys;
  let candidate;
  try {
    keys = Object.keys(value);
    candidate = {
      offlineEnabled: value.offlineEnabled ?? false,
      sourceClass: value.sourceClass ?? "local-user",
    };
  } catch (cause) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_USER_SETTINGS_INVALID",
      "Protected-compute user settings are unreadable.",
      { cause: String(cause) },
    );
  }
  exactFields(candidate, LOCAL_USER_FIELDS, "Protected-compute user settings");
  if (
    candidate.sourceClass !== "local-user" ||
    typeof candidate.offlineEnabled !== "boolean"
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_USER_SETTINGS_INVALID",
      "Protected-compute user settings are invalid.",
    );
  }
  if (keys.some((key) => !LOCAL_USER_FIELDS.includes(key))) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_USER_SETTINGS_INVALID",
      "Server URLs, keys, formulas, and policy cannot be overridden by local-user settings.",
    );
  }
  return Object.freeze(candidate);
}

export function createProtectedComputeClientFromSignedConfig({
  signedPublicConfig,
  configTrustStore,
  localUserSettings,
  dynamicRevocationProvider,
  now,
  ...clientOptions
} = {}) {
  const verifiedConfig = verifySignedPublicProtectedComputeConfig(
    signedPublicConfig,
    { configTrustStore, now },
  );
  const userSettings = normalizeProtectedComputeLocalUserSettings(
    localUserSettings,
  );
  const client = createProtectedComputeClient({
    ...clientOptions,
    baseUrl: verifiedConfig.serverBaseUrl,
    trustStore: verifiedConfig.trustStore,
    now,
    revocationProvider: async () => {
      const dynamic = dynamicRevocationProvider
        ? await dynamicRevocationProvider()
        : {};
      return {
        minimumEpoch: Math.max(
          verifiedConfig.revocationState.minimumEpoch,
          Number.isSafeInteger(dynamic?.minimumEpoch)
            ? dynamic.minimumEpoch
            : 0,
        ),
        revokedCapabilities: [
          ...new Set([
            ...verifiedConfig.revocationState.revokedCapabilities,
            ...(dynamic?.revokedCapabilities || []),
          ]),
        ],
        revokedKeyIds: [
          ...new Set([
            ...verifiedConfig.revocationState.revokedKeyIds,
            ...(dynamic?.revokedKeyIds || []),
          ]),
        ],
        revokedResponseIds: [...new Set(dynamic?.revokedResponseIds || [])],
      };
    },
  });
  return Object.freeze({
    execute(request, options = {}) {
      return client.execute(request, {
        ...options,
        allowOffline:
          userSettings.offlineEnabled && options.allowOffline !== false,
      });
    },
    config: verifiedConfig,
    userSettings,
  });
}
