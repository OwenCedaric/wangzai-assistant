import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { publicKeyFingerprint, verifyOfflineToken } from "./offlineTokenVerifier.js";

function createToken(privateKey, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "key-v1", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: "9",
      license_id: 9,
      project_code: "wangzai_desktop",
      device_code: "WZ-test-device",
      permissions: ["orders.view", "orders.view"],
      device_limit: 2,
      shop_limit: 3,
      iat: now,
      nbf: now,
      exp: now + 3600,
      offline_until: now + 3600,
      expire: now + 86400,
      license_expire: now + 86400,
      iss: "license-center",
      aud: "license-center-clients",
      ...overrides,
    }),
  ).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function expected(publicKey) {
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  return {
    publicKeyPem,
    keyId: "key-v1",
    expectedKeyFingerprint: publicKeyFingerprint(publicKeyPem),
    projectCode: "wangzai_desktop",
    deviceCode: "WZ-test-device",
  };
}

test("verifies Ed25519 offline claims and normalizes permissions", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const claims = verifyOfflineToken(createToken(privateKey), expected(publicKey));
  assert.deepEqual(claims.permissions, ["orders.view"]);
  assert.equal(claims.device_limit, 2);
  assert.match(claims.offline_until, /^\d{4}-/);
});

test("rejects tampering, device replay, expiry, and a wrong pinned key", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const valid = createToken(privateKey);
  const options = expected(publicKey);
  const parts = valid.split(".");
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ project_code: "other" })).toString(
    "base64url",
  )}.${parts[2]}`;
  assert.throws(() => verifyOfflineToken(tampered, options), /签名/);
  assert.throws(
    () => verifyOfflineToken(valid, { ...options, deviceCode: "WZ-other-device" }),
    /不匹配/,
  );
  assert.throws(
    () => verifyOfflineToken(createToken(privateKey, { exp: 1, offline_until: 1 }), options),
    /过期/,
  );
  assert.throws(
    () => verifyOfflineToken(valid, { ...options, expectedKeyFingerprint: "0".repeat(64) }),
    /指纹/,
  );
});
