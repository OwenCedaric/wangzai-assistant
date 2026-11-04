import { protectedComputeContractError } from "./protectedComputeError.js";

const FORBIDDEN_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|client[_-]?id|client[_-]?secret|password|passwd|cookie|authorization|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|ozon[_-]?key|secret)(?:$|[_-])/iu;
const FORBIDDEN_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /(?:^|\r?\n)(?:Api-Key|Client-Id|Cookie|Authorization)\s*:/imu,
];

export function assertNoProtectedComputeSecrets(value) {
  const pending = [{ path: "$", value }];
  const seen = new Set();
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    visited += 1;
    if (visited > 20_000) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_INPUT_LIMIT_EXCEEDED",
        "Protected-compute input is too large.",
      );
    }
    if (typeof current.value === "string") {
      if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(current.value))) {
        throw protectedComputeContractError(
          "PROTECTED_COMPUTE_SECRET_REJECTED",
          "Credentials and secret material are forbidden in protected-compute input.",
          { path: current.path },
        );
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_INPUT_CYCLIC",
        "Protected-compute input cannot contain cycles.",
      );
    }
    seen.add(current.value);
    let keys;
    try {
      keys = Object.keys(current.value);
    } catch (cause) {
      throw protectedComputeContractError(
        "PROTECTED_COMPUTE_INPUT_INVALID",
        "Protected-compute input contains an unreadable object.",
        { path: current.path, cause: String(cause) },
      );
    }
    for (const key of keys) {
      const path = `${current.path}.${key}`;
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw protectedComputeContractError(
          "PROTECTED_COMPUTE_SECRET_REJECTED",
          "Credentials and secret material are forbidden in protected-compute input.",
          { path },
        );
      }
      let child;
      try {
        child = current.value[key];
      } catch (cause) {
        throw protectedComputeContractError(
          "PROTECTED_COMPUTE_INPUT_INVALID",
          "Protected-compute input contains an unreadable property.",
          { path, cause: String(cause) },
        );
      }
      pending.push({ path, value: child });
    }
  }
}

export const protectedComputeSecretPatterns = Object.freeze({
  key: FORBIDDEN_KEY_PATTERN,
  values: Object.freeze([...FORBIDDEN_VALUE_PATTERNS]),
});
