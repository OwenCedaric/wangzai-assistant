import { createPublicKey } from "node:crypto";

import { protectedComputeContractError } from "./protectedComputeError.js";

function normalizePublicKey(value) {
  let key;
  try {
    key =
      value?.type === "public" && value?.asymmetricKeyType
        ? value
        : createPublicKey(value);
  } catch (cause) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_TRUST_KEY_INVALID",
      "Protected-compute trust key is invalid.",
      { cause: String(cause) },
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_TRUST_KEY_INVALID",
      "Protected-compute trust keys must use Ed25519.",
    );
  }
  return key;
}

export function createStaticProtectedComputeTrustStore({ keys = {} } = {}) {
  const trusted = new Map();
  for (const [keyId, value] of Object.entries(keys)) {
    const normalizedKeyId = String(keyId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(normalizedKeyId)) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_TRUST_KEY_INVALID",
        "Protected-compute keyId is invalid.",
      );
    }
    trusted.set(normalizedKeyId, normalizePublicKey(value));
  }
  if (!trusted.size) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_TRUST_STORE_EMPTY",
      "At least one pinned protected-compute public key is required.",
    );
  }
  return Object.freeze({
    getPublicKey(keyId) {
      return trusted.get(String(keyId)) || null;
    },
    listKeyIds() {
      return [...trusted.keys()];
    },
  });
}
