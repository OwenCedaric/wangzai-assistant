import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isProtectedComputeTestFixtureHostname,
  loadProtectedComputeDistribution,
  PROTECTED_COMPUTE_RESOURCE_PATHS,
} from "../src/licensing/protectedComputeDistribution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesRoot = path.resolve(__dirname, "..", "resources");
const outputPath = path.join(resourcesRoot, "distribution.json");
const protectedComputeRoot = path.join(resourcesRoot, "protected-compute");
const BUNDLE_METADATA_FILE = "desktop-protected-compute.json";
const BUNDLE_METADATA_FIELDS = Object.freeze([
  "configExpiresAt",
  "configVersion",
  "configurationKeyId",
  "configurationKeySha256",
  "configurationPublicKeyPath",
  "contract",
  "serverBaseUrl",
  "signedConfigPath",
  "signedConfigSha256",
]);
const EMPTY_PROTECTED_COMPUTE = Object.freeze({
  configuration_key_id: "",
  configuration_key_sha256: "",
  configuration_public_key_path: "",
  signed_config_path: "",
});

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length).trim() : fallback;
}

function distributionToken() {
  if (process.argv.some((value) => value.startsWith("--token="))) {
    throw new Error("不要在命令行明文传 token，请改用 --token-file 或 --token-stdin");
  }
  const tokenFile = argument("token-file");
  const fromStdin = process.argv.includes("--token-stdin");
  if (tokenFile && fromStdin) {
    throw new Error("--token-file 与 --token-stdin 只能选择一种");
  }
  if (tokenFile) return fs.readFileSync(path.resolve(tokenFile), "utf8").trim();
  if (fromStdin) return fs.readFileSync(0, "utf8").trim();
  return String(process.env.WANGZAI_DISTRIBUTION_TOKEN || "").trim();
}

function validServerUrl(
  value,
  { productionEnforce = false, allowTestFixtureUrls = false } = {},
) {
  const parsed = new URL(value);
  const local = new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("非本机 License Center 地址必须使用 HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("License Center 地址不能包含 userinfo、query 或 fragment");
  }
  if (
    productionEnforce
    && allowTestFixtureUrls !== true
    && isProtectedComputeTestFixtureHostname(parsed.hostname)
  ) {
    throw new Error("enforce License Center 不能使用占位、文档保留、localhost 或 loopback 主机");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new Error(`${label} 字段不符合固定契约`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPublicOnlyBundle(bundleRoot) {
  const allowedFiles = new Set([
    BUNDLE_METADATA_FILE,
    PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey,
    PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig,
  ]);
  const pending = [bundleRoot];
  const found = new Set();
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(bundleRoot, target).replace(/\\/gu, "/");
      if (entry.isSymbolicLink()) throw new Error(`public bundle 不允许符号链接：${relative}`);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile() || !allowedFiles.has(relative)) {
        throw new Error(`public bundle 包含未批准文件：${relative}`);
      }
      found.add(relative);
    }
  }
  for (const required of allowedFiles) {
    if (!found.has(required)) throw new Error(`public bundle 缺少文件：${required}`);
  }
}

function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function stageProtectedComputeBundle({
  bundleRoot,
  expectedServerUrl,
  expectedKeyId,
  allowTestFixtureUrls = false,
}) {
  const sourceRoot = path.resolve(bundleRoot);
  assertPublicOnlyBundle(sourceRoot);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, BUNDLE_METADATA_FILE), "utf8").replace(/^\uFEFF/u, ""),
  );
  exactFields(metadata, BUNDLE_METADATA_FIELDS, "desktop protected-compute bundle metadata");
  if (
    metadata.contract !== "desktop-protected-compute-bundle/v1"
    || metadata.configurationPublicKeyPath !== PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey
    || metadata.signedConfigPath !== PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(metadata.configurationKeyId || "")
    || !/^[a-f0-9]{64}$/u.test(metadata.configurationKeySha256 || "")
    || !/^[a-f0-9]{64}$/u.test(metadata.signedConfigSha256 || "")
  ) {
    throw new Error("desktop protected-compute bundle metadata 无效");
  }
  if (expectedKeyId && metadata.configurationKeyId !== expectedKeyId) {
    throw new Error("public bundle 的 configuration key ID 与发布参数不一致");
  }

  const protectedCompute = {
    configuration_key_id: metadata.configurationKeyId,
    configuration_key_sha256: metadata.configurationKeySha256,
    configuration_public_key_path: metadata.configurationPublicKeyPath,
    signed_config_path: metadata.signedConfigPath,
  };
  const verified = loadProtectedComputeDistribution({
    distribution: { protected_compute: protectedCompute },
    licenseRoot: sourceRoot,
    expectedServerUrl,
    required: true,
    minimumRemainingMs: 24 * 60 * 60 * 1000,
    allowTestFixtureUrls: allowTestFixtureUrls === true,
  });
  const signedBytes = fs.readFileSync(
    path.join(sourceRoot, ...PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig.split("/")),
  );
  if (
    sha256(signedBytes) !== metadata.signedConfigSha256
    || verified.configVersion !== metadata.configVersion
    || verified.configExpiresAt !== metadata.configExpiresAt
    || verified.serverBaseUrl !== metadata.serverBaseUrl
  ) {
    throw new Error("public bundle metadata 与签名配置不一致");
  }

  const sourcePublicKey = path.join(
    sourceRoot,
    ...PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey.split("/"),
  );
  const destinationPublicKey = path.join(
    resourcesRoot,
    ...PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey.split("/"),
  );
  const destinationSignedConfig = path.join(
    resourcesRoot,
    ...PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig.split("/"),
  );
  atomicWrite(destinationPublicKey, fs.readFileSync(sourcePublicKey));
  atomicWrite(destinationSignedConfig, signedBytes);

  loadProtectedComputeDistribution({
    distribution: { protected_compute: protectedCompute },
    licenseRoot: resourcesRoot,
    expectedServerUrl,
    required: true,
    minimumRemainingMs: 24 * 60 * 60 * 1000,
    allowTestFixtureUrls: allowTestFixtureUrls === true,
  });
  return protectedCompute;
}

const mode = argument("mode", "observe").toLowerCase();
if (!["off", "observe", "enforce"].includes(mode)) {
  throw new Error("--mode 只能是 off、observe 或 enforce");
}
const channelDisabled = process.argv.includes("--no-channel");
const channelCode = channelDisabled ? "" : argument("channel", "DIRECT");
if (channelCode && !/^[A-Za-z0-9_.-]{2,64}$/u.test(channelCode)) {
  throw new Error("--channel 格式不正确");
}
const offlineKeySha256 = argument("key-sha256").toLowerCase();
if (offlineKeySha256 && !/^[a-f0-9]{64}$/u.test(offlineKeySha256)) {
  throw new Error("--key-sha256 必须是 64 位 SHA-256 十六进制指纹");
}
if (mode === "enforce" && !offlineKeySha256) {
  throw new Error("enforce 模式必须提供 --key-sha256 离线公钥指纹");
}
const allowTestFixtureUrls = process.argv.includes("--allow-test-fixture-urls");
const serverUrl = validServerUrl(
  argument("server", "http://127.0.0.1:8000"),
  {
    productionEnforce: mode === "enforce",
    allowTestFixtureUrls,
  },
);
if (mode === "enforce" && new URL(serverUrl).protocol !== "https:") {
  throw new Error("enforce 模式的 License Center 必须使用 HTTPS");
}
const protectedBundle = argument("protected-bundle");
if (mode === "enforce" && !protectedBundle) {
  throw new Error("enforce 模式必须提供 --protected-bundle 公共签名配置包");
}
const expectedProtectedKeyId = argument("protected-config-key-id");
if (
  expectedProtectedKeyId
  && !/^[A-Za-z0-9._:-]{1,128}$/u.test(expectedProtectedKeyId)
) {
  throw new Error("--protected-config-key-id 格式无效");
}

const configuration = {
  version: 1,
  project_code: argument("project", "wangzai_desktop"),
  channel_code: channelCode,
  campaign_code: argument("campaign", "direct"),
  distribution_token: distributionToken(),
  license_mode: mode,
  license_center_url: serverUrl,
  jwt_issuer: argument("issuer", "license-center"),
  jwt_audience: argument("audience", "license-center-clients"),
  offline_key_sha256: offlineKeySha256,
  protected_compute: protectedBundle
    ? stageProtectedComputeBundle({
      bundleRoot: protectedBundle,
      expectedServerUrl: serverUrl,
      expectedKeyId: expectedProtectedKeyId,
      allowTestFixtureUrls,
    })
    : { ...EMPTY_PROTECTED_COMPUTE },
};

if (channelDisabled && configuration.distribution_token) {
  throw new Error("--no-channel 不允许同时提供分发 Token");
}

const temporary = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, "utf8");
fs.rmSync(outputPath, { force: true });
fs.renameSync(temporary, outputPath);
process.stdout.write(
  `已更新渠道配置：project=${configuration.project_code} channel=${configuration.channel_code} mode=${configuration.license_mode} protected=${Boolean(protectedBundle)}\n`,
);
