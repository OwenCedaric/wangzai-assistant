import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SEALED_LICENSE_MANIFEST_SHA256_ALLOWLIST } from "./sealedLicenseManifest.js";
import { loadUiUpdateConfig } from '../updates/uiUpdateConfig.js';
import {
  isProtectedComputeTestFixtureCampaign,
  isProtectedComputeTestFixtureHostname,
  loadProtectedComputeDistribution,
  isLocalSelfHostingUrl,
} from "./protectedComputeDistribution.js";

const MODES = new Set(["off", "observe", "enforce"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeOptionalHttpsUrl(value, label) {
  const raw = String(value || "").trim().replace(/\/$/u, "");
  if (!raw) return "";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new Error(`${label} 非本机地址必须使用 HTTPS`);
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function readJson(filePath, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeServerUrl(
  value,
  { productionEnforce = false, allowTestFixtureUrls = false, allowLocalSelfHosting = false } = {},
) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  if (!raw) return "http://127.0.0.1:8000";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new Error("License Center 非本机地址必须使用 HTTPS");
  }
  if (
    productionEnforce
    && allowTestFixtureUrls !== true
    && !(allowLocalSelfHosting && isLocalSelfHostingUrl(raw))
    && isProtectedComputeTestFixtureHostname(parsed.hostname)
  ) {
    throw new Error("enforce License Center 不能使用占位、文档保留、localhost 或 loopback 主机");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function computeLicenseManifestSha256(projectPath, distributionPath) {
  const hash = crypto.createHash("sha256");
  hash.update("wangzai-license-manifest-v1\0", "utf8");
  for (const filePath of [projectPath, distributionPath]) {
    const bytes = fs.readFileSync(filePath);
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function verifySealedManifest(projectPath, distributionPath, expectedDigest) {
  const candidates = (Array.isArray(expectedDigest) ? expectedDigest : [expectedDigest])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/.test(value));
  if (!candidates.length) {
    throw new Error("正式安装包缺少内置 License 配置摘要");
  }
  const actual = Buffer.from(computeLicenseManifestSha256(projectPath, distributionPath), "hex");
  const matched = candidates.some((candidate) => (
    crypto.timingSafeEqual(actual, Buffer.from(candidate, "hex"))
  ));
  if (!matched) throw new Error("License 项目或渠道配置已被修改");
}

export function loadLicenseConfig({
  app,
  desktopRoot,
  resourcesPath,
  sealedManifestSha256 = SEALED_LICENSE_MANIFEST_SHA256_ALLOWLIST,
  now,
  allowTestFixtureUrls = false,
}) {
  const licenseRoot = app.isPackaged
    ? path.join(resourcesPath, "license")
    : path.join(desktopRoot, "resources");
  const projectPath = path.join(licenseRoot, "project.json");
  const distributionPath = path.join(licenseRoot, "distribution.json");
  if (app.isPackaged) verifySealedManifest(projectPath, distributionPath, sealedManifestSha256);
  const project = readJson(projectPath);
  const distribution = readJson(distributionPath);
  const localSelfHosting = !app.isPackaged && distribution.local_self_hosting === true;
  if (localSelfHosting && !isLocalSelfHostingUrl(distribution.license_center_url)) {
    throw new Error('LOCAL_SELF_HOSTING_REQUIRES_LOOPBACK_HTTPS');
  }
  const allowEnvironmentOverrides = !app.isPackaged;
  const requestedMode = String(
    (allowEnvironmentOverrides && process.env.WANGZAI_LICENSE_MODE) ||
      distribution.license_mode ||
      "observe",
  ).toLowerCase();
  const mode = app.isPackaged || localSelfHosting ? "enforce" : MODES.has(requestedMode) ? requestedMode : "observe";
  const testFixtureUrlOptIn = !app.isPackaged && (
    allowTestFixtureUrls === true
    || process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS === "1"
  );
  const projectCode = String(project.code || distribution.project_code || "wangzai_desktop").trim();
  if (!projectCode) throw new Error("License project code 不能为空");
  if (distribution.project_code && distribution.project_code !== projectCode) {
    throw new Error("License 项目代码与分发配置不一致");
  }
  const campaignCode = String(distribution.campaign_code || "direct").trim();
  if (app.isPackaged && isProtectedComputeTestFixtureCampaign(campaignCode)) {
    throw new Error("正式安装包不能使用 test/fixture 活动代码");
  }

  const offlineKeyFingerprint = String(distribution.offline_key_sha256 || "")
    .trim()
    .toLowerCase();
  if ((app.isPackaged || localSelfHosting) && mode === "enforce" && !/^[a-f0-9]{64}$/.test(offlineKeyFingerprint)) {
    throw new Error("enforce 安装包缺少有效的离线公钥 SHA-256 指纹");
  }

  const serverUrl = normalizeServerUrl(
    (allowEnvironmentOverrides && process.env.LICENSE_CENTER_URL) ||
      distribution.license_center_url,
    {
      productionEnforce: mode === "enforce",
      allowTestFixtureUrls: testFixtureUrlOptIn,
      allowLocalSelfHosting: localSelfHosting,
    },
  );
  const protectedCompute = loadProtectedComputeDistribution({
    distribution,
    licenseRoot,
    expectedServerUrl: serverUrl,
    required: (app.isPackaged && mode === "enforce") || localSelfHosting,
    now,
    allowTestFixtureUrls: testFixtureUrlOptIn,
    allowLocalSelfHosting: localSelfHosting,
  });
  const thinClientEnabled = distribution.thin_client === true;
  const thinClientArchitecture = thinClientEnabled
    ? String(distribution.thin_client_architecture || "legacy").trim().toLowerCase()
    : "off";
  if (!new Set(["off", "legacy", "v2"]).has(thinClientArchitecture)) {
    throw new Error("薄客户端架构版本无效");
  }
  const coreServiceUrl = normalizeOptionalHttpsUrl(
    distribution.core_service_url || (thinClientArchitecture === "v2" ? serverUrl : ""),
    "核心业务服务",
  );
  const coreClientId = String(distribution.core_client_id || "").trim();
  if (
    thinClientEnabled
    && (
      !coreServiceUrl
      || (thinClientArchitecture === "legacy" && !/^[A-Za-z0-9._:-]{16,160}$/u.test(coreClientId))
    )
  ) {
    throw new Error("薄客户端缺少有效的核心业务服务地址或客户端标识");
  }

  return Object.freeze({
    mode,
    serverUrl,
    projectCode,
    projectName: String(project.name || app.getName()).trim(),
    localSelfHosting,
    version: String(project.version || app.getVersion()).trim(),
    versionHash: String(project.version_hash || "").trim(),
    channelCode: String(distribution.channel_code || "DIRECT").trim(),
    campaignCode,
    distributionToken: String(distribution.distribution_token || "").trim(),
    jwtIssuer: String(distribution.jwt_issuer || "license-center").trim(),
    jwtAudience: String(distribution.jwt_audience || "license-center-clients").trim(),
    offlineKeyFingerprint,
    protectedCompute,
    uiUpdate: loadUiUpdateConfig({ value: distribution.ui_update, licenseRoot, serverUrl }),
    thinClient: Object.freeze({
      enabled: thinClientEnabled,
      architecture: thinClientArchitecture,
      coreServiceUrl,
      clientId: coreClientId,
    }),
  });
}

export function publicLicenseConfig(config, deviceCode) {
  return {
    mode: config.mode,
    serverUrl: config.serverUrl,
    projectCode: config.projectCode,
    projectName: config.projectName,
    version: config.version,
    versionHash: config.versionHash,
    channelCode: config.channelCode,
    campaignCode: config.campaignCode,
    deviceCode,
    thinClient: config.thinClient?.enabled === true,
  };
}
