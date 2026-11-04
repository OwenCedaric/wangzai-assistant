import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeLicenseManifestSha256, loadLicenseConfig } from "./licenseConfig.js";
import {
  PROTECTED_COMPUTE_RESOURCE_PATHS,
  protectedComputePublicKeyFingerprint,
} from "./protectedComputeDistribution.js";

const PACKAGED_NOW = new Date("2026-07-16T00:00:00.000Z");
const PRODUCTION_SERVER_URL = "https://license.wangzai.cn";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function writeProtectedComputeResources(licenseRoot, serverBaseUrl = PRODUCTION_SERVER_URL) {
  const configurationKeys = generateKeyPairSync("ed25519");
  const computeKeys = generateKeyPairSync("ed25519");
  const protectedRoot = path.join(licenseRoot, "protected-compute");
  fs.mkdirSync(protectedRoot, { recursive: true });
  const configurationPublicKeyPem = configurationKeys.publicKey.export({
    type: "spki",
    format: "pem",
  });
  fs.writeFileSync(
    path.join(protectedRoot, "configuration-public.pem"),
    configurationPublicKeyPem,
    "utf8",
  );
  const payload = {
    computeKeys: [{
      algorithm: "Ed25519",
      keyId: "compute-v1",
      publicKeyPem: computeKeys.publicKey.export({ type: "spki", format: "pem" }),
    }],
    configVersion: 1,
    contract: "signed-public-protected-compute-config/v1",
    expiresAt: "2026-08-15T00:00:00.000Z",
    issuedAt: PACKAGED_NOW.toISOString(),
    revocationEpoch: 0,
    revokedCapabilities: [],
    revokedKeyIds: [],
    serverBaseUrl,
    signatureAlgorithm: "Ed25519",
    signingKeyId: "config-v1",
  };
  fs.writeFileSync(
    path.join(protectedRoot, "protected-compute.signed-public.json"),
    JSON.stringify({
      ...payload,
      signature: sign(null, Buffer.from(canonicalJson(payload)), configurationKeys.privateKey)
        .toString("base64url"),
    }),
    "utf8",
  );
  return {
    configuration_key_id: "config-v1",
    configuration_key_sha256: protectedComputePublicKeyFingerprint(configurationPublicKeyPem),
    configuration_public_key_path: PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey,
    signed_config_path: PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig,
  };
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".license-config-test-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources);
  fs.writeFileSync(
    path.join(resources, "project.json"),
    JSON.stringify({ name: "测试项目", code: "test_project", version: "2.0.0" }),
  );
  fs.writeFileSync(
    path.join(resources, "distribution.json"),
    JSON.stringify({ channel_code: "AGENT-8", distribution_token: "dist-token" }),
  );
  return root;
}

test("loads project and channel without coupling them to business modules", () => {
  const root = fixtureRoot();
  const previousUrl = process.env.LICENSE_CENTER_URL;
  const previousMode = process.env.WANGZAI_LICENSE_MODE;
  const previousFixtureUrls = process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
  process.env.LICENSE_CENTER_URL = "https://license.example.test/";
  process.env.WANGZAI_LICENSE_MODE = "enforce";
  delete process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
  try {
    assert.throws(
      () => loadLicenseConfig({
        app: { isPackaged: false, getName: () => "app", getVersion: () => "1.0.0" },
        desktopRoot: root,
        resourcesPath: "",
      }),
      /占位|保留|loopback/u,
    );
    process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = "1";
    const config = loadLicenseConfig({
      app: { isPackaged: false, getName: () => "app", getVersion: () => "1.0.0" },
      desktopRoot: root,
      resourcesPath: "",
    });
    assert.equal(config.projectCode, "test_project");
    assert.equal(config.channelCode, "AGENT-8");
    assert.equal(config.mode, "enforce");
    assert.equal(config.serverUrl, "https://license.example.test");
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    if (previousMode === undefined) delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = previousMode;
    if (previousFixtureUrls === undefined) delete process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
    else process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = previousFixtureUrls;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects plaintext remote License Center URLs", () => {
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://license.example.test";
  try {
    assert.throws(
      () =>
        loadLicenseConfig({
          app: { isPackaged: false, getName: () => "app", getVersion: () => "1.0.0" },
          desktopRoot: path.resolve("."),
          resourcesPath: "",
        }),
      /HTTPS/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
  }
});

test("packaged enforce mode ignores environment bypasses and requires a pinned key", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".license-config-test-"));
  const resources = path.join(root, "license");
  fs.mkdirSync(resources);
  fs.writeFileSync(
    path.join(resources, "project.json"),
    JSON.stringify({ code: "test_project", version: "1.0.0" }),
  );
  const protectedCompute = writeProtectedComputeResources(resources);
  fs.writeFileSync(
    path.join(resources, "distribution.json"),
    JSON.stringify({
      license_mode: "enforce",
      license_center_url: PRODUCTION_SERVER_URL,
      offline_key_sha256: "a".repeat(64),
      protected_compute: protectedCompute,
    }),
  );
  const previousUrl = process.env.LICENSE_CENTER_URL;
  const previousMode = process.env.WANGZAI_LICENSE_MODE;
  process.env.LICENSE_CENTER_URL = "https://attacker.example.test";
  process.env.WANGZAI_LICENSE_MODE = "off";
  try {
    const app = { isPackaged: true, getName: () => "app", getVersion: () => "1.0.0" };
    const manifestPaths = [
      path.join(resources, "project.json"),
      path.join(resources, "distribution.json"),
    ];
    const config = loadLicenseConfig({
      app,
      desktopRoot: root,
      resourcesPath: root,
      sealedManifestSha256: computeLicenseManifestSha256(...manifestPaths),
      now: () => PACKAGED_NOW,
    });
    assert.equal(config.mode, "enforce");
    assert.equal(config.serverUrl, PRODUCTION_SERVER_URL);
    const distributionPath = path.join(resources, "distribution.json");
    fs.writeFileSync(
      distributionPath,
      JSON.stringify({ license_mode: "enforce", license_center_url: PRODUCTION_SERVER_URL }),
    );
    assert.throws(
      () =>
        loadLicenseConfig({
          app,
          desktopRoot: root,
          resourcesPath: root,
          sealedManifestSha256: computeLicenseManifestSha256(...manifestPaths),
          now: () => PACKAGED_NOW,
        }),
      /指纹/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    if (previousMode === undefined) delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = previousMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged enforce mode cannot enable the test-fixture URL opt-in", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".license-config-test-"));
  const resources = path.join(root, "license");
  fs.mkdirSync(resources);
  const fixtureUrl = "https://license.example.test";
  fs.writeFileSync(
    path.join(resources, "project.json"),
    JSON.stringify({ code: "test_project", version: "1.0.0" }),
  );
  const protectedCompute = writeProtectedComputeResources(resources, fixtureUrl);
  fs.writeFileSync(
    path.join(resources, "distribution.json"),
    JSON.stringify({
      license_mode: "enforce",
      license_center_url: fixtureUrl,
      offline_key_sha256: "a".repeat(64),
      protected_compute: protectedCompute,
    }),
  );
  const manifestPaths = [
    path.join(resources, "project.json"),
    path.join(resources, "distribution.json"),
  ];
  const previousFixtureUrls = process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
  process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = "1";
  try {
    assert.throws(
      () => loadLicenseConfig({
        app: { isPackaged: true, getName: () => "app", getVersion: () => "1.0.0" },
        desktopRoot: root,
        resourcesPath: root,
        sealedManifestSha256: computeLicenseManifestSha256(...manifestPaths),
        now: () => PACKAGED_NOW,
        allowTestFixtureUrls: true,
      }),
      /占位|保留|localhost|loopback/u,
    );
  } finally {
    if (previousFixtureUrls === undefined) delete process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
    else process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = previousFixtureUrls;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged enforce mode rejects a test-only campaign even on a production HTTPS host", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".license-config-test-"));
  const resources = path.join(root, "license");
  fs.mkdirSync(resources);
  fs.writeFileSync(
    path.join(resources, "project.json"),
    JSON.stringify({ code: "test_project", version: "1.0.0" }),
  );
  const protectedCompute = writeProtectedComputeResources(resources, PRODUCTION_SERVER_URL);
  fs.writeFileSync(
    path.join(resources, "distribution.json"),
    JSON.stringify({
      license_mode: "enforce",
      license_center_url: PRODUCTION_SERVER_URL,
      campaign_code: "test-fixture",
      offline_key_sha256: "a".repeat(64),
      protected_compute: protectedCompute,
    }),
  );
  const manifestPaths = [
    path.join(resources, "project.json"),
    path.join(resources, "distribution.json"),
  ];
  try {
    assert.throws(
      () => loadLicenseConfig({
        app: { isPackaged: true, getName: () => "app", getVersion: () => "1.0.0" },
        desktopRoot: root,
        resourcesPath: root,
        sealedManifestSha256: computeLicenseManifestSha256(...manifestPaths),
        now: () => PACKAGED_NOW,
      }),
      /test\/fixture 活动代码/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
