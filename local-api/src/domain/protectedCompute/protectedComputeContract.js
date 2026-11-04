import { randomBytes, randomUUID } from "node:crypto";

import { sha256Canonical } from "./canonicalJson.js";
import { getProtectedComputeCapability } from "./capabilityRegistry.js";
import { protectedComputeContractError } from "./protectedComputeError.js";
import { assertNoProtectedComputeSecrets } from "./secretGuard.js";

export const PROTECTED_COMPUTE_REQUEST_CONTRACT =
  "protected-compute-request/v1";
export const PROTECTED_COMPUTE_RESULT_CONTRACT = "protected-compute-result/v1";

const REQUEST_FIELDS = Object.freeze([
  "capability",
  "contract",
  "input",
  "inputHash",
  "issuedAt",
  "nonce",
  "requestId",
  "version",
]);

export function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_TIMESTAMP_INVALID",
      "Protected-compute timestamp is invalid.",
    );
  }
  return date.toISOString();
}

export function assertExactObjectFields(value, expected, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protectedComputeContractError(code, `${label} must be an object.`);
  }
  let keys;
  try {
    keys = Object.keys(value).sort();
  } catch (cause) {
    throw protectedComputeContractError(code, `${label} is unreadable.`, {
      cause: String(cause),
    });
  }
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw protectedComputeContractError(
      code,
      `${label} fields do not match the signed contract.`,
      { expectedFields: expected, actualFields: keys },
    );
  }
}

export function createProtectedComputeRequest(
  { capability, version, input },
  {
    now = () => new Date(),
    requestIdFactory = randomUUID,
    nonceFactory = () => randomBytes(32).toString("base64url"),
  } = {},
) {
  assertNoProtectedComputeSecrets(input);
  const descriptor = getProtectedComputeCapability(capability, version);
  const normalizedInput = descriptor.normalizeInput(input);
  const request = {
    capability: descriptor.capability,
    contract: PROTECTED_COMPUTE_REQUEST_CONTRACT,
    input: normalizedInput,
    inputHash: sha256Canonical(normalizedInput),
    issuedAt: toIsoTimestamp(now()),
    nonce: String(nonceFactory()),
    requestId: String(requestIdFactory()),
    version: descriptor.version,
  };
  validateProtectedComputeRequest(request);
  return Object.freeze({
    ...request,
    input: Object.freeze({ ...normalizedInput }),
  });
}

export function validateProtectedComputeRequest(request) {
  assertExactObjectFields(
    request,
    REQUEST_FIELDS,
    "PROTECTED_COMPUTE_REQUEST_INVALID",
    "Protected-compute request",
  );
  if (request.contract !== PROTECTED_COMPUTE_REQUEST_CONTRACT) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_REQUEST_INVALID",
      "Protected-compute request contract is unsupported.",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      request.requestId,
    )
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_REQUEST_INVALID",
      "Protected-compute requestId is invalid.",
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(request.nonce)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_REQUEST_INVALID",
      "Protected-compute nonce is invalid.",
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(request.inputHash)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_REQUEST_INVALID",
      "Protected-compute inputHash is invalid.",
    );
  }
  toIsoTimestamp(request.issuedAt);
  const descriptor = getProtectedComputeCapability(
    request.capability,
    request.version,
  );
  assertNoProtectedComputeSecrets(request.input);
  const normalizedInput = descriptor.normalizeInput(request.input);
  if (sha256Canonical(normalizedInput) !== request.inputHash) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_HASH_MISMATCH",
      "Protected-compute inputHash does not match the normalized input.",
    );
  }
  return request;
}

export const protectedComputeContractFields = Object.freeze({
  request: REQUEST_FIELDS,
  response: Object.freeze([
    "capability",
    "contract",
    "expiresAt",
    "inputHash",
    "issuedAt",
    "keyId",
    "nonce",
    "offlinePolicy",
    "offlineUntil",
    "requestId",
    "responseId",
    "result",
    "revocationEpoch",
    "signature",
    "signatureAlgorithm",
    "version",
  ]),
  offlinePolicy: Object.freeze(["allowed", "maxUses", "scope"]),
});
