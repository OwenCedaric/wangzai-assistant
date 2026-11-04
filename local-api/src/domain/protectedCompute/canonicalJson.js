import { createHash, timingSafeEqual } from "node:crypto";

import { protectedComputeContractError } from "./protectedComputeError.js";

const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 20_000;

function normalizeString(value) {
  return value.normalize("NFC");
}

function encodeCanonical(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CANONICAL_LIMIT_EXCEEDED",
      "Protected-compute payload exceeds the canonical JSON limit.",
    );
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(normalizeString(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_NUMBER_INVALID",
        "Protected-compute payload numbers must be safe integers.",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw protectedComputeContractError(
          "PROTECTED_COMPUTE_ARRAY_INVALID",
          "Protected-compute payload arrays cannot contain holes.",
        );
      }
      parts.push(encodeCanonical(value[index], state, depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value !== "object") {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_VALUE_INVALID",
      "Protected-compute payload contains an unsupported value.",
    );
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (cause) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_OBJECT_INVALID",
      "Protected-compute payload contains an unreadable object.",
      { cause: String(cause) },
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_OBJECT_INVALID",
      "Protected-compute payload accepts plain objects only.",
    );
  }
  let keys;
  try {
    keys = Object.keys(value);
  } catch (cause) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_OBJECT_INVALID",
      "Protected-compute payload contains an unreadable object.",
      { cause: String(cause) },
    );
  }
  const normalizedKeys = new Map();
  for (const key of keys) {
    const normalized = normalizeString(key);
    if (normalizedKeys.has(normalized)) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_KEY_COLLISION",
        "Protected-compute payload contains canonically duplicate keys.",
      );
    }
    normalizedKeys.set(normalized, key);
  }
  const parts = [];
  for (const normalizedKey of [...normalizedKeys.keys()].sort()) {
    const originalKey = normalizedKeys.get(normalizedKey);
    let child;
    try {
      child = value[originalKey];
    } catch (cause) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_OBJECT_INVALID",
        "Protected-compute payload contains an unreadable property.",
        { cause: String(cause) },
      );
    }
    parts.push(
      `${JSON.stringify(normalizedKey)}:${encodeCanonical(child, state, depth + 1)}`,
    );
  }
  return `{${parts.join(",")}}`;
}

export function canonicalJson(value) {
  return encodeCanonical(value, { nodes: 0 }, 0);
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function constantTimeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
