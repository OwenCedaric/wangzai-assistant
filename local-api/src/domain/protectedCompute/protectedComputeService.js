import { listProtectedComputeContracts } from "./capabilityRegistry.js";
import { assertExactObjectFields } from "./protectedComputeContract.js";
import {
  ProtectedComputeError,
  protectedComputeContractError,
} from "./protectedComputeError.js";
import { assertNoProtectedComputeSecrets } from "./secretGuard.js";

const EXECUTE_FIELDS = Object.freeze(["capability", "input", "version"]);
const VERIFIED_SOURCES = new Set(["server-signed", "offline-signed"]);

function normalizeAccessToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 8_192 || /[\r\n]/u.test(token)) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_AUTH_UNAVAILABLE",
      "A short-lived license access token is required for protected compute.",
      { status: 401, retriable: false },
    );
  }
  return token;
}

function normalizeExecuteRequest(value) {
  // Scan the complete renderer DTO first so secret-shaped extra fields receive
  // the stable secret rejection code instead of being hidden by exact-field
  // validation. The token used for transport never enters this DTO.
  assertNoProtectedComputeSecrets(value);
  assertExactObjectFields(
    value,
    EXECUTE_FIELDS,
    "PROTECTED_COMPUTE_REQUEST_INVALID",
    "Local protected-compute request",
  );
  return {
    capability: value.capability,
    input: value.input,
    version: value.version,
  };
}

function safeRuntimeStatus(runtimeStatus, client) {
  const source = runtimeStatus && typeof runtimeStatus === "object"
    ? runtimeStatus
    : {};
  const available = Boolean(client?.execute) && source.available !== false;
  return {
    available,
    configured: available && source.configured !== false,
    configVersion: Number.isSafeInteger(source.configVersion)
      ? source.configVersion
      : null,
    configExpiresAt: typeof source.configExpiresAt === "string"
      ? source.configExpiresAt
      : null,
    offlineEnabled: available && source.offlineEnabled === true,
    reasonCode: available
      ? null
      : String(source.reasonCode || "PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED"),
  };
}

function verifiedResponseDto(verified) {
  if (
    !verified
    || typeof verified !== "object"
    || verified.signatureVerified !== true
    || !VERIFIED_SOURCES.has(verified.source)
    || !verified.envelope
    || typeof verified.envelope !== "object"
  ) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RESULT_UNVERIFIED",
      "Protected-compute output was not verified and cannot be used.",
      { status: 502, retriable: false },
    );
  }
  const envelope = verified.envelope;
  return {
    ok: true,
    contract: "local-protected-compute-result/v1",
    capability: envelope.capability,
    version: envelope.version,
    result: structuredClone(verified.result),
    source: verified.source,
    signatureVerified: true,
    verification: {
      responseId: envelope.responseId,
      keyId: envelope.keyId,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      offlineUntil: envelope.offlineUntil,
      revocationEpoch: envelope.revocationEpoch,
      onlineErrorCode:
        verified.source === "offline-signed"
          ? String(verified.onlineErrorCode || "PROTECTED_COMPUTE_OFFLINE")
          : null,
    },
  };
}

export function createProtectedComputeService({
  client = null,
  runtimeStatus = null,
} = {}) {
  function resolveStatus() {
    try {
      const source = typeof runtimeStatus === "function"
        ? runtimeStatus()
        : runtimeStatus;
      return safeRuntimeStatus(source, client);
    } catch (error) {
      return safeRuntimeStatus({
        available: false,
        configured: false,
        reasonCode:
          typeof error?.code === "string" && error.code.startsWith("PROTECTED_COMPUTE_")
            ? error.code
            : "PROTECTED_COMPUTE_RUNTIME_CONFIG_INVALID",
      }, client);
    }
  }

  function getStatus() {
    const status = resolveStatus();
    return {
      ok: true,
      contract: "local-protected-compute-status/v1",
      ...status,
      contracts: listProtectedComputeContracts(),
    };
  }

  function listContracts() {
    return {
      ok: true,
      contract: "local-protected-compute-contracts/v1",
      contracts: listProtectedComputeContracts(),
    };
  }

  async function execute(value, { accessToken } = {}) {
    const status = resolveStatus();
    if (!status.available || !client?.execute) {
      throw new ProtectedComputeError(
        status.reasonCode || "PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED",
        "Protected compute is not configured on this local runtime.",
        { status: 503, retriable: false },
      );
    }
    const request = normalizeExecuteRequest(value);
    const token = normalizeAccessToken(accessToken);
    const verified = await client.execute(request, {
      // This provider is request-scoped. It is supplied by the Electron main
      // process over the authenticated loopback channel and is never stored in
      // the renderer DTO, signed-result cache, logs, or response.
      accessTokenProvider: async () => token,
    });
    return verifiedResponseDto(verified);
  }

  return Object.freeze({
    domain: "protected-compute",
    execute,
    getStatus,
    listContracts,
  });
}

export function assertProtectedComputeRouteRequest(value) {
  try {
    return normalizeExecuteRequest(value);
  } catch (error) {
    if (error instanceof ProtectedComputeError) throw error;
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_REQUEST_INVALID",
      "Local protected-compute request is invalid.",
    );
  }
}
