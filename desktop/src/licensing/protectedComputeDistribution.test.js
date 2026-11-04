import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isProtectedComputeTestFixtureCampaign,
  PROTECTED_COMPUTE_RESOURCE_PATHS,
  loadProtectedComputeDistribution,
  protectedComputePublicKeyFingerprint,
} from "./protectedComputeDistribution.js";

const NOW = new Date("2026-07-16T00:00:00.000Z");

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signedConfig(configurationPrivateKey, computePublicKey, overrides = {}) {
  const payload = {
    computeKeys: [{
      algorithm: "Ed25519",
      keyId: "protected-compute-v1",
      publicKeyPem: computePublicKey.export({ type: "spki", format: "pem" }),
    }],
    configVersion: 7,
    contract: "signed-public-protected-compute-config/v1",
    expiresAt: "2026-08-15T00:00:00.000Z",
    issuedAt: NOW.toISOString(),
    revocationEpoch: 3,
    revokedCapabilities: [],
    revokedKeyIds: [],
    serverBaseUrl: "https://license.wangzai.cn",
    signatureAlgorithm: "Ed25519",
    signingKeyId: "protected-config-v1",
    ...overrides,
  };
  return {
    ...payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), configurationPrivateKey)
      .toString("base64url"),
  };
}

function writeFixture(root, configOverrides = {}) {
  const configurationKeys = generateKeyPairSync("ed25519");
  const computeKeys = generateKeyPairSync("ed25519");
  const protectedRoot = path.join(root, "protected-compute");
  fs.mkdirSync(protectedRoot, { recursive: true });
  const publicKeyPem = configurationKeys.publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(path.join(protectedRoot, "configuration-public.pem"), publicKeyPem, "utf8");
  fs.writeFileSync(
    path.join(protectedRoot, "protected-compute.signed-public.json"),
    JSON.stringify(signedConfig(
      configurationKeys.privateKey,
      computeKeys.publicKey,
      configOverrides,
    )),
    "utf8",
  );
  return {
    configurationKeys,
    computeKeys,
    distribution: {
      protected_compute: {
        configuration_key_id: "protected-config-v1",
        configuration_key_sha256: protectedComputePublicKeyFingerprint(publicKeyPem),
        configuration_public_key_path: PROTECTED_COMPUTE_RESOURCE_PATHS.configurationPublicKey,
        signed_config_path: PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig,
      },
    },
  };
}

test("sealed distribution binds signed config path, Ed25519 fingerprint, signature, expiry, and HTTPS server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-distribution-"));
  try {
    const fixture = writeFixture(root);
    const loaded = loadProtectedComputeDistribution({
      distribution: fixture.distribution,
      licenseRoot: root,
      expectedServerUrl: "https://license.wangzai.cn",
      required: true,
      now: () => NOW,
      minimumRemainingMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(loaded.signatureVerified, true);
    assert.equal(loaded.configVersion, 7);
    assert.equal(loaded.configurationKeyId, "protected-config-v1");

    assert.throws(
      () => loadProtectedComputeDistribution({
        distribution: {
          protected_compute: {
            ...fixture.distribution.protected_compute,
            signed_config_path: "../protected-compute.signed-public.json",
          },
        },
        licenseRoot: root,
        expectedServerUrl: "https://license.wangzai.cn",
        required: true,
        now: () => NOW,
      }),
      /必须固定/u,
    );

    const configPath = path.join(root, ...PROTECTED_COMPUTE_RESOURCE_PATHS.signedConfig.split("/"));
    const tampered = JSON.parse(fs.readFileSync(configPath, "utf8"));
    tampered.serverBaseUrl = "https://attacker.wangzai.cn";
    fs.writeFileSync(configPath, JSON.stringify(tampered), "utf8");
    assert.throws(
      () => loadProtectedComputeDistribution({
        distribution: fixture.distribution,
        licenseRoot: root,
        expectedServerUrl: "https://license.wangzai.cn",
        required: true,
        now: () => NOW,
      }),
      /URL 不一致|签名无效/u,
    );

    fs.writeFileSync(
      configPath,
      JSON.stringify(signedConfig(fixture.configurationKeys.privateKey, fixture.computeKeys.publicKey, {
        expiresAt: "2026-07-16T12:00:00.000Z",
      })),
      "utf8",
    );
    assert.throws(
      () => loadProtectedComputeDistribution({
        distribution: fixture.distribution,
        licenseRoot: root,
        expectedServerUrl: "https://license.wangzai.cn",
        required: true,
        now: () => NOW,
        minimumRemainingMs: 24 * 60 * 60 * 1000,
      }),
      /即将过期/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("placeholder, documentation-reserved, localhost, and loopback URLs require an explicit fixture opt-in", () => {
  const fixtureUrls = [
    "https://license.invalid",
    "https://license.example",
    "https://license.example.test",
    "https://license.example.com",
    "https://temporary-release.trycloudflare.com",
    "https://localhost",
    "https://127.0.0.2",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
  ];
  for (const serverBaseUrl of fixtureUrls) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-fixture-url-"));
    try {
      const fixture = writeFixture(root, { serverBaseUrl });
      const options = {
        distribution: fixture.distribution,
        licenseRoot: root,
        expectedServerUrl: serverBaseUrl,
        required: true,
        now: () => NOW,
      };
      assert.throws(
        () => loadProtectedComputeDistribution(options),
        /占位|保留|localhost|loopback/u,
        serverBaseUrl,
      );
      assert.throws(
        () => loadProtectedComputeDistribution({
          ...options,
          allowTestFixtureUrls: "true",
        }),
        /占位|保留|localhost|loopback/u,
        `${serverBaseUrl} must not accept a string opt-in`,
      );
      const loaded = loadProtectedComputeDistribution({
        ...options,
        allowTestFixtureUrls: true,
      });
      assert.equal(loaded.signatureVerified, true, serverBaseUrl);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("test-only campaign codes never qualify as production distribution metadata", () => {
  for (const value of ["test", "fixture", "test-fixture", "test_fixture", "fixture-smoke"]) {
    assert.equal(isProtectedComputeTestFixtureCampaign(value), true, value);
  }
  for (const value of ["direct", "summer-2026", "partner_cn"]) {
    assert.equal(isProtectedComputeTestFixtureCampaign(value), false, value);
  }
});
