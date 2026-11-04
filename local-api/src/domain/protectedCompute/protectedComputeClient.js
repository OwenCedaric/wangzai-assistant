import {
  createProtectedComputeRequest,
  validateProtectedComputeRequest,
} from "./protectedComputeContract.js";
import {
  ProtectedComputeError,
  isProtectedComputeError,
} from "./protectedComputeError.js";
import {
  MemoryProtectedComputeReplayGuard,
  MemoryProtectedComputeSignedResultStore,
} from "./protectedComputeStores.js";
import { verifyProtectedComputeEnvelope } from "./protectedComputeVerifier.js";

const EXECUTE_PATH = "/api/protected-compute/execute";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PRIVATE_PROFIT_RESPONSE_BYTES = 16 * 1024 * 1024 + 64 * 1024;

function validateBaseUrl(value, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_BASE_URL_INVALID",
      "Protected-compute server URL is invalid.",
      { status: 500, cause },
    );
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  ) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_BASE_URL_INVALID",
      "Protected-compute server URL must be trusted HTTPS without userinfo, query, or fragment.",
      { status: 500 },
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${EXECUTE_PATH}`;
  return url.toString();
}

function normalizeAccessToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 8_192 || /[\r\n]/u.test(token)) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_AUTH_UNAVAILABLE",
      "An ephemeral license access token is required for protected compute.",
      { status: 401, retriable: false },
    );
  }
  return token;
}

function createRemoteError(status, body, headers) {
  const retriable = [502, 503, 504].includes(status);
  const remoteCode =
    body && typeof body === "object" && typeof body.code === "string"
      ? body.code
      : body &&
          typeof body === "object" &&
          body.detail &&
          typeof body.detail === "object" &&
          typeof body.detail.code === "string"
        ? body.detail.code
      : null;
  return new ProtectedComputeError(
    remoteCode || "PROTECTED_COMPUTE_REMOTE_ERROR",
    "Protected-compute server rejected the request.",
    { status, retriable, ...(status === 429 && /^\d+$/u.test(headers?.get?.('retry-after') || '')
      ? { details: { retryAfterMs: Math.max(1, Math.min(60_000, Number(headers.get('retry-after')) * 1000)) } } : {}) },
  );
}

async function parseResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.();
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RESPONSE_TOO_LARGE",
      "Protected-compute response exceeds the size limit.",
      { status: 502 },
    );
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ProtectedComputeError("PROTECTED_COMPUTE_RESPONSE_TOO_LARGE",
            "Protected-compute response exceeds the size limit.", { status: 502 });
        }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks, size).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RESPONSE_TOO_LARGE",
      "Protected-compute response exceeds the size limit.",
      { status: 502 },
    );
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (cause) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_RESPONSE_INVALID",
      "Protected-compute server returned invalid JSON.",
      { status: 502, cause },
    );
  }
  if (!response.ok) throw createRemoteError(response.status, body, response.headers);
  return body;
}

async function resolveRevocationState(provider) {
  if (!provider) return {};
  const state =
    typeof provider === "function"
      ? await provider()
      : await provider.getRevocationState?.();
  return state && typeof state === "object" ? state : {};
}

export function createProtectedComputeClient({
  baseUrl,
  trustStore,
  accessTokenProvider,
  revocationProvider,
  fetchImpl = globalThis.fetch,
  replayGuard = new MemoryProtectedComputeReplayGuard(),
  signedResultStore = new MemoryProtectedComputeSignedResultStore(),
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowInsecureLoopback = false,
  requestFactoryOptions = {},
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_TRANSPORT_UNAVAILABLE",
      "Protected-compute HTTP transport is unavailable.",
      { retriable: true },
    );
  }
  if (!trustStore?.getPublicKey) {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_TRUST_STORE_INVALID",
      "A pinned protected-compute trust store is required.",
    );
  }
  if (typeof accessTokenProvider !== "function") {
    throw new ProtectedComputeError(
      "PROTECTED_COMPUTE_AUTH_PROVIDER_INVALID",
      "An ephemeral access-token provider is required.",
    );
  }
  const endpoint = validateBaseUrl(baseUrl, allowInsecureLoopback);

  async function useOfflineResult(request, onlineError) {
    const identity = {
      capability: request.capability,
      version: request.version,
      inputHash: request.inputHash,
    };
    const cached = await signedResultStore.get(identity);
    if (!cached) throw onlineError;
    const verified = verifyProtectedComputeEnvelope(cached.envelope, {
      expected: identity,
      trustStore,
      revocationState: await resolveRevocationState(revocationProvider),
      mode: "offline",
      now,
    });
    const consumed = await signedResultStore.consume(
      identity,
      cached.envelope.responseId,
      cached.envelope.offlinePolicy.maxUses,
    );
    if (!consumed) {
      throw new ProtectedComputeError(
        "PROTECTED_COMPUTE_OFFLINE_USES_EXHAUSTED",
        "The signed offline result has exhausted its allowed uses.",
        { status: 503, retriable: false },
      );
    }
    return Object.freeze({
      ...verified,
      onlineErrorCode: onlineError?.code || "PROTECTED_COMPUTE_OFFLINE",
    });
  }

  async function execute(
    { capability, version, input },
    { allowOffline = false, signal, accessTokenProvider: requestAccessTokenProvider } = {},
  ) {
    const request = createProtectedComputeRequest(
      { capability, version, input },
      { ...requestFactoryOptions, now },
    );
    validateProtectedComputeRequest(request);
    const controller = new AbortController();
    const privateProfit = request.capability === 'profit.ledger-batch' && request.version === 1;
    const requestTimeoutMs = privateProfit && timeoutMs === DEFAULT_TIMEOUT_MS ? 32_000 : timeoutMs;
    const safeTimeoutMs = Math.max(250, Math.min(Number(requestTimeoutMs) || 0, 60_000));
    const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let onlineError;
    try {
      const tokenProvider = requestAccessTokenProvider ?? accessTokenProvider;
      if (typeof tokenProvider !== "function") {
        throw new ProtectedComputeError(
          "PROTECTED_COMPUTE_AUTH_PROVIDER_INVALID",
          "An ephemeral access-token provider is required.",
          { status: 401, retriable: false },
        );
      }
      const token = normalizeAccessToken(await tokenProvider());
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal: controller.signal,
      });
      const envelope = await parseResponse(response, privateProfit && response.ok ? PRIVATE_PROFIT_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
      const verified = verifyProtectedComputeEnvelope(envelope, {
        expected: request,
        trustStore,
        replayGuard,
        revocationState: await resolveRevocationState(revocationProvider),
        mode: "online",
        now,
      });
      if (
        envelope.offlinePolicy.allowed &&
        envelope.offlinePolicy.maxUses > 0 &&
        envelope.offlineUntil
      ) {
        await signedResultStore.put(envelope);
      }
      return verified;
    } catch (cause) {
      if (isProtectedComputeError(cause)) {
        onlineError = cause;
      } else if (cause?.name === "AbortError") {
        onlineError = new ProtectedComputeError(
          "PROTECTED_COMPUTE_TIMEOUT",
          "Protected-compute request timed out.",
          { cause, status: 504, retriable: true },
        );
      } else {
        onlineError = new ProtectedComputeError(
          "PROTECTED_COMPUTE_NETWORK_UNAVAILABLE",
          "Protected-compute server is unavailable.",
          { cause, status: 503, retriable: true },
        );
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    if (allowOffline && onlineError.retriable) {
      return useOfflineResult(request, onlineError);
    }
    throw onlineError;
  }

  return Object.freeze({
    execute,
    endpoint,
  });
}

export const protectedComputeClientDefaults = Object.freeze({
  executePath: EXECUTE_PATH,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
