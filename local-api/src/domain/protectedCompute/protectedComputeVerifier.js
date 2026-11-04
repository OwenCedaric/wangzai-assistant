import { verify } from "node:crypto";

import {
  canonicalJson,
  constantTimeTextEqual,
} from "./canonicalJson.js";
import {
  PROTECTED_COMPUTE_RESULT_CONTRACT,
  assertExactObjectFields,
  protectedComputeContractFields,
} from "./protectedComputeContract.js";
import { getProtectedComputeCapability } from "./capabilityRegistry.js";
import { ProtectedComputeError } from "./protectedComputeError.js";

function fail(code, message, details) {
  throw new ProtectedComputeError(code, message, {
    status: 502,
    retriable: false,
    details,
  });
}

function parseTimestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value)) {
    fail("PROTECTED_COMPUTE_RESULT_INVALID", `${field} is invalid.`);
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    fail("PROTECTED_COMPUTE_RESULT_INVALID", `${field} is invalid.`);
  }
  return timestamp;
}

function normalizeRevocationState(value = {}) {
  return {
    minimumEpoch: Number.isSafeInteger(value.minimumEpoch)
      ? value.minimumEpoch
      : 0,
    revokedCapabilities: new Set(value.revokedCapabilities || []),
    revokedKeyIds: new Set(value.revokedKeyIds || []),
    revokedResponseIds: new Set(value.revokedResponseIds || []),
  };
}

export function getProtectedComputeSignedPayload(envelope) {
  const { signature: _signature, ...payload } = envelope;
  return payload;
}

export function verifyProtectedComputeEnvelope(
  envelope,
  {
    expected,
    trustStore,
    replayGuard,
    revocationState,
    mode = "online",
    now = () => new Date(),
    maxClockSkewMs = 60_000,
    maxResultLifetimeMs = 3_600_000,
  } = {},
) {
  try {
    assertExactObjectFields(
      envelope,
      protectedComputeContractFields.response,
      "PROTECTED_COMPUTE_RESULT_INVALID",
      "Protected-compute result",
    );
    assertExactObjectFields(
      envelope.offlinePolicy,
      protectedComputeContractFields.offlinePolicy,
      "PROTECTED_COMPUTE_RESULT_INVALID",
      "Protected-compute offline policy",
    );
  } catch (cause) {
    fail(
      cause?.code || "PROTECTED_COMPUTE_RESULT_INVALID",
      cause?.message || "Protected-compute result is invalid.",
    );
  }
  if (
    envelope.contract !== PROTECTED_COMPUTE_RESULT_CONTRACT ||
    envelope.signatureAlgorithm !== "Ed25519" ||
    !Number.isSafeInteger(envelope.version) ||
    !Number.isSafeInteger(envelope.revocationEpoch) ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(envelope.keyId || "") ||
    !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      envelope.responseId || "",
    ) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(envelope.nonce || "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(envelope.inputHash || "")
  ) {
    fail(
      "PROTECTED_COMPUTE_RESULT_INVALID",
      "Protected-compute result contract values are invalid.",
    );
  }
  if (
    typeof envelope.offlinePolicy.allowed !== "boolean" ||
    !Number.isSafeInteger(envelope.offlinePolicy.maxUses) ||
    envelope.offlinePolicy.maxUses < 0 ||
    envelope.offlinePolicy.scope !== "input-hash"
  ) {
    fail(
      "PROTECTED_COMPUTE_RESULT_INVALID",
      "Protected-compute offline policy is invalid.",
    );
  }
  const nowMs = new Date(now()).getTime();
  const issuedAtMs = parseTimestamp(envelope.issuedAt, "issuedAt");
  const expiresAtMs = parseTimestamp(envelope.expiresAt, "expiresAt");
  const offlineUntilMs =
    envelope.offlineUntil === null
      ? null
      : parseTimestamp(envelope.offlineUntil, "offlineUntil");
  if (
    issuedAtMs > nowMs + maxClockSkewMs ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > maxResultLifetimeMs ||
    expiresAtMs <= nowMs ||
    (offlineUntilMs !== null &&
      (offlineUntilMs > expiresAtMs || offlineUntilMs <= issuedAtMs))
  ) {
    fail(
      expiresAtMs <= nowMs
        ? "PROTECTED_COMPUTE_RESULT_EXPIRED"
        : "PROTECTED_COMPUTE_RESULT_TIME_INVALID",
      "Protected-compute result validity window is invalid or expired.",
    );
  }
  if (
    envelope.capability !== expected?.capability ||
    envelope.version !== expected?.version ||
    !constantTimeTextEqual(envelope.inputHash, expected?.inputHash)
  ) {
    fail(
      "PROTECTED_COMPUTE_RESULT_BINDING_MISMATCH",
      "Protected-compute result is not bound to the requested input.",
    );
  }
  if (
    mode === "online" &&
    (envelope.requestId !== expected?.requestId ||
      !constantTimeTextEqual(envelope.nonce, expected?.nonce))
  ) {
    fail(
      "PROTECTED_COMPUTE_RESULT_BINDING_MISMATCH",
      "Protected-compute result is not bound to this request nonce.",
    );
  }
  const state = normalizeRevocationState(revocationState);
  if (
    envelope.revocationEpoch < state.minimumEpoch ||
    state.revokedKeyIds.has(envelope.keyId) ||
    state.revokedCapabilities.has(`${envelope.capability}@${envelope.version}`) ||
    state.revokedCapabilities.has(envelope.capability) ||
    state.revokedResponseIds.has(envelope.responseId)
  ) {
    fail(
      "PROTECTED_COMPUTE_RESULT_REVOKED",
      "Protected-compute result has been revoked.",
    );
  }
  const publicKey = trustStore?.getPublicKey?.(envelope.keyId);
  if (!publicKey) {
    fail(
      "PROTECTED_COMPUTE_SIGNING_KEY_UNTRUSTED",
      "Protected-compute result uses an untrusted signing key.",
    );
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(getProtectedComputeSignedPayload(envelope))),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    fail(
      "PROTECTED_COMPUTE_SIGNATURE_INVALID",
      "Protected-compute result signature is invalid.",
    );
  }
  let typedResult;
  try {
    typedResult = getProtectedComputeCapability(
      envelope.capability,
      envelope.version,
    ).validateResult(envelope.result);
  } catch {
    fail(
      "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
      "Protected-compute result does not match its typed capability contract.",
    );
  }
  if (mode === "offline") {
    if (
      !envelope.offlinePolicy.allowed ||
      envelope.offlinePolicy.maxUses < 1 ||
      offlineUntilMs === null ||
      offlineUntilMs <= nowMs
    ) {
      fail(
        "PROTECTED_COMPUTE_OFFLINE_NOT_ALLOWED",
        "This signed result is not valid for offline use.",
      );
    }
  } else if (
    replayGuard &&
    !replayGuard.claim(envelope.responseId, envelope.expiresAt, nowMs)
  ) {
    fail(
      "PROTECTED_COMPUTE_REPLAY_REJECTED",
      "Protected-compute result replay was rejected.",
    );
  }
  return Object.freeze({
    envelope,
    result: typedResult,
    signatureVerified: true,
    source: mode === "offline" ? "offline-signed" : "server-signed",
  });
}
