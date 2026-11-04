import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROTECTED_COMPUTE_RESOURCE_PATHS = Object.freeze({
  signedConfig: "protected-compute/protected-compute.signed-public.json",
  configurationPublicKey: "protected-compute/configuration-public.pem",
});

const MAX_SIGNED_CONFIG_BYTES = 256 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const MAX_CONFIG_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const RESERVED_FIXTURE_TLDS = Object.freeze([
  ".example",
  ".invalid",
  ".localhost",
  ".test",
]);
const RESERVED_DOCUMENTATION_DOMAINS = Object.freeze([
  "example.com",
  "example.net",
  "example.org",
]);
const TEST_ONLY_TUNNEL_DOMAINS = Object.freeze([
  "trycloudflare.com",
]);
const DISTRIBUTION_FIELDS = Object.freeze([
  "configuration_key_id",
  "configuration_key_sha256",
  "configuration_public_key_path",
  "signed_config_path",
]);
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

function fail(message) {
  throw new Error(`PROTECTED_COMPUTE_DISTRIBUTION_INVALID:${message}`);
}

function exactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} 字段不符合固定契约`);
  }
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("签名配置包含非安全整数");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("签名配置包含不支持的值");
}

function readBoundedRegularFile(filePath, maximumBytes, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} 不存在`);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1
    || stat.size > maximumBytes
  ) {
    fail(`${label} 不是受支持的普通文件`);
  }
  return fs.readFileSync(filePath);
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail(`${label} 不是有效 JSON`);
  }
}

function publicKeyFromPem(publicKeyPem, label) {
  if (/-----BEGIN [^-]*PRIVATE KEY-----/u.test(publicKeyPem)) {
    fail(`${label} 不能包含私钥`);
  }
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    fail(`${label} 不是有效公钥`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${label} 必须使用 Ed25519`);
  return key;
}

export function protectedComputePublicKeyFingerprint(publicKeyPem) {
  const key = publicKeyFromPem(publicKeyPem, "配置公钥");
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function timestamp(value, label) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value)
  ) {
    fail(`${label} 不是 UTC 时间`);
  }
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) fail(`${label} 无法解析`);
  return result;
}

function normalizedHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/gu, "");
}

function isIpv4Loopback(hostname) {
  const octets = hostname.split(".");
  return (
    octets.length === 4
    && octets.every((value) => /^\d{1,3}$/u.test(value) && Number(value) <= 255)
    && Number(octets[0]) === 127
  );
}

function isIpv4MappedLoopback(hostname) {
  if (!hostname.startsWith("::ffff:")) return false;
  const mapped = hostname.slice("::ffff:".length);
  if (isIpv4Loopback(mapped)) return true;
  const hextets = mapped.split(":");
  if (
    hextets.length !== 2
    || hextets.some((value) => !/^[a-f0-9]{1,4}$/u.test(value))
  ) {
    return false;
  }
  const high = Number.parseInt(hextets[0], 16);
  return high >= 0x7f00 && high <= 0x7fff;
}

export function isProtectedComputeTestFixtureHostname(value) {
  const hostname = normalizedHostname(value);
  if (!hostname) return false;
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "localhost.localdomain"
    || hostname.endsWith(".localhost.localdomain")
    || hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || isIpv4Loopback(hostname)
    || isIpv4MappedLoopback(hostname)
  ) {
    return true;
  }
  if (
    RESERVED_FIXTURE_TLDS.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    return true;
  }
  if (
    TEST_ONLY_TUNNEL_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    )
  ) {
    return true;
  }
  return RESERVED_DOCUMENTATION_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function isProtectedComputeTestFixtureCampaign(value) {
  const campaign = String(value || "").trim().toLowerCase();
  return /^(?:test|fixture)(?:[-_].*)?$/u.test(campaign)
    || /^(?:test[-_]?fixture)(?:[-_].*)?$/u.test(campaign);
}

export function isLocalSelfHostingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function normalizedHttpsUrl(value, label, { allowTestFixtureUrls = false, allowLocalSelfHosting = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    fail(`${label} 无法解析`);
  }
  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    fail(`${label} 必须是无 userinfo、query、fragment 的 HTTPS 地址`);
  }
  if (
    allowTestFixtureUrls !== true
    && !(allowLocalSelfHosting === true && isLocalSelfHostingUrl(value))
    && isProtectedComputeTestFixtureHostname(url.hostname)
  ) {
    fail(`${label} 不能使用占位、文档保留、localhost 或 loopback 主机`);
  }
  return url.toString().replace(/\/+$/u, "");
}

function validateRevocationList(values, pattern, label) {
  if (
    !Array.isArray(values)
    || values.some((value) => typeof value !== "string" || !pattern.test(value))
    || new Set(values).size !== values.length
  ) {
    fail(`${label} 无效`);
  }
}

function resolveFixedResource(licenseRoot, configuredPath, expectedPath, label) {
  const normalized = String(configuredPath || "").replace(/\\/gu, "/");
  if (normalized !== expectedPath) fail(`${label} 必须固定为 ${expectedPath}`);
  const root = path.resolve(licenseRoot);
  const target = path.resolve(root, ...expectedPath.split("/"));
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail(`${label} 越出 License 资源目录`);
  }
  return target;
}

export function verifySignedProtectedComputePublicConfig({
  signedConfig,
  configurationPublicKeyPem,
  configurationKeyId,
  configurationKeySha256,
  expectedServerUrl,
  now = () => new Date(),
  minimumRemainingMs = 0,
  allowTestFixtureUrls = false,
  allowLocalSelfHosting = false,
}) {
  exactFields(signedConfig, SIGNED_CONFIG_FIELDS, "signed-public 配置");
  if (
    signedConfig.contract !== "signed-public-protected-compute-config/v1"
    || signedConfig.signatureAlgorithm !== "Ed25519"
    || !Number.isSafeInteger(signedConfig.configVersion)
    || signedConfig.configVersion < 1
    || !Number.isSafeInteger(signedConfig.revocationEpoch)
    || signedConfig.revocationEpoch < 0
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(signedConfig.signingKeyId || "")
    || !/^[A-Za-z0-9_-]{86}$/u.test(signedConfig.signature || "")
    || signedConfig.signingKeyId !== configurationKeyId
  ) {
    fail("signed-public 配置基础字段无效");
  }
  const normalizedFingerprint = String(configurationKeySha256 || "").toLowerCase();
  if (
    !/^[a-f0-9]{64}$/u.test(normalizedFingerprint)
    || protectedComputePublicKeyFingerprint(configurationPublicKeyPem) !== normalizedFingerprint
  ) {
    fail("配置公钥 SHA-256 指纹不匹配");
  }
  const issuedAtMs = timestamp(signedConfig.issuedAt, "issuedAt");
  const expiresAtMs = timestamp(signedConfig.expiresAt, "expiresAt");
  const nowMs = new Date(now()).getTime();
  if (!Number.isFinite(nowMs)) fail("本机时间无效");
  if (
    issuedAtMs > nowMs + 60_000
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_CONFIG_LIFETIME_MS
    || expiresAtMs <= nowMs + Math.max(0, Number(minimumRemainingMs) || 0)
  ) {
    fail("signed-public 配置已过期、即将过期或有效窗口无效");
  }
  const fixtureUrlPolicy = { allowTestFixtureUrls: allowTestFixtureUrls === true, allowLocalSelfHosting };
  const serverBaseUrl = normalizedHttpsUrl(
    signedConfig.serverBaseUrl,
    "受保护计算服务器 URL",
    fixtureUrlPolicy,
  );
  if (
    expectedServerUrl
    && serverBaseUrl !== normalizedHttpsUrl(
      expectedServerUrl,
      "License Center URL",
      fixtureUrlPolicy,
    )
  ) {
    fail("受保护计算服务器 URL 与 sealed License Center URL 不一致");
  }
  validateRevocationList(
    signedConfig.revokedCapabilities,
    /^[a-z][a-z0-9.-]+(?:@\d+)?$/u,
    "revokedCapabilities",
  );
  validateRevocationList(
    signedConfig.revokedKeyIds,
    /^[A-Za-z0-9._:-]{1,128}$/u,
    "revokedKeyIds",
  );
  if (!Array.isArray(signedConfig.computeKeys) || !signedConfig.computeKeys.length) {
    fail("computeKeys 不能为空");
  }
  const computeKeyIds = new Set();
  for (const item of signedConfig.computeKeys) {
    exactFields(item, COMPUTE_KEY_FIELDS, "compute key");
    if (
      item.algorithm !== "Ed25519"
      || !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.keyId || "")
      || computeKeyIds.has(item.keyId)
    ) {
      fail("compute key 元数据无效");
    }
    publicKeyFromPem(item.publicKeyPem, `compute key ${item.keyId}`);
    computeKeyIds.add(item.keyId);
  }
  const { signature, ...payload } = signedConfig;
  const configurationPublicKey = publicKeyFromPem(configurationPublicKeyPem, "配置公钥");
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(payload)),
      configurationPublicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) fail("signed-public 配置签名无效");
  return Object.freeze({
    configVersion: signedConfig.configVersion,
    expiresAt: signedConfig.expiresAt,
    revocationEpoch: signedConfig.revocationEpoch,
    serverBaseUrl,
    signatureVerified: true,
  });
}

export function loadProtectedComputeDistribution({
  distribution,
  licenseRoot,
  expectedServerUrl,
  required = false,
  now,
  minimumRemainingMs = 0,
  allowTestFixtureUrls = false,
  allowLocalSelfHosting = false,
} = {}) {
  const value = distribution?.protected_compute;
  if (value === undefined || value === null) {
    if (required) fail("sealed distribution 缺少 protected_compute 配置");
    return null;
  }
  exactFields(value, DISTRIBUTION_FIELDS, "distribution.protected_compute");
  const configuredValues = DISTRIBUTION_FIELDS.map((field) => String(value[field] || "").trim());
  if (configuredValues.every((item) => !item)) {
    if (required) fail("sealed distribution 的 protected_compute 配置为空");
    return null;
  }
  if (configuredValues.some((item) => !item)) fail("protected_compute 配置不完整");
  const configurationKeyId = String(value.configuration_key_id).trim();
  const configurationKeySha256 = String(value.configuration_key_sha256).trim().toLowerCase();
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(configurationKeyId)) fail("configuration_key_id 无效");
  if (!/^[a-f0-9]{64}$/u.test(configurationKeySha256)) fail("configuration_key_sha256 无效");

  const signedPublicConfigPath = resolveFixedResource(
    licenseRoot,
    value.signed_config_path,
    PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig,
    "signed_config_path",
  );
  const configurationPublicKeyPath = resolveFixedResource(
    licenseRoot,
    value.configuration_public_key_path,
    PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey,
    "configuration_public_key_path",
  );
  const signedConfig = parseJson(
    readBoundedRegularFile(signedPublicConfigPath, MAX_SIGNED_CONFIG_BYTES, "signed-public 配置"),
    "signed-public 配置",
  );
  const configurationPublicKeyPem = readBoundedRegularFile(
    configurationPublicKeyPath,
    MAX_PUBLIC_KEY_BYTES,
    "配置公钥",
  ).toString("utf8").replace(/^\uFEFF/u, "");
  const verified = verifySignedProtectedComputePublicConfig({
    signedConfig,
    configurationPublicKeyPem,
    configurationKeyId,
    configurationKeySha256,
    expectedServerUrl,
    now,
    minimumRemainingMs,
    allowTestFixtureUrls: allowTestFixtureUrls === true,
    allowLocalSelfHosting,
  });
  return Object.freeze({
    signedPublicConfigPath,
    configurationPublicKeyPath,
    configurationKeyId,
    configurationKeySha256,
    configVersion: verified.configVersion,
    configExpiresAt: verified.expiresAt,
    revocationEpoch: verified.revocationEpoch,
    serverBaseUrl: verified.serverBaseUrl,
    signatureVerified: true,
  });
}
