import crypto from "node:crypto";

const CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("离线凭证编码无效");
  return Buffer.from(value, "base64url");
}

function decodeJson(value, label) {
  try {
    return JSON.parse(decodeBase64Url(value).toString("utf8"));
  } catch {
    throw new Error(`${label}无效`);
  }
}

function numericClaim(payload, name) {
  const value = Number(payload?.[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`离线凭证缺少 ${name}`);
  return value;
}

function stringList(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("离线凭证权限列表无效");
  }
  return [...new Set(value)].sort();
}

export function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

export function verifyOfflineToken(
  token,
  {
    publicKeyPem,
    keyId,
    expectedKeyFingerprint = "",
    issuer = "license-center",
    audience = "license-center-clients",
    projectCode,
    deviceCode,
    now = Date.now(),
  },
) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part || part.length > 32_768)) {
    throw new Error("离线凭证格式无效");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader, "离线凭证头");
  const payload = decodeJson(encodedPayload, "离线凭证内容");
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || header.kid !== keyId) {
    throw new Error("离线凭证签名算法或密钥标识无效");
  }
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("离线验签公钥类型无效");
  if (
    expectedKeyFingerprint &&
    publicKeyFingerprint(publicKeyPem).toLowerCase() !== expectedKeyFingerprint.toLowerCase()
  ) {
    throw new Error("离线验签公钥指纹不匹配");
  }
  const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
  const signature = decodeBase64Url(encodedSignature);
  if (!crypto.verify(null, signedData, key, signature)) throw new Error("离线凭证签名无效");

  const issuedAt = numericClaim(payload, "iat");
  const notBefore = numericClaim(payload, "nbf");
  const expiresAt = numericClaim(payload, "exp");
  const offlineUntil = numericClaim(payload, "offline_until");
  const licenseExpire = numericClaim(payload, "license_expire");
  const nowSeconds = Math.floor(now / 1000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || notBefore > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("离线凭证尚未生效");
  }
  if (expiresAt <= nowSeconds || offlineUntil <= nowSeconds || licenseExpire <= nowSeconds) {
    throw new Error("离线凭证已过期");
  }
  if (expiresAt !== offlineUntil || offlineUntil > licenseExpire) {
    throw new Error("离线凭证时间范围无效");
  }
  if (
    payload.iss !== issuer ||
    payload.aud !== audience ||
    payload.project_code !== projectCode ||
    payload.device_code !== deviceCode
  ) {
    throw new Error("离线凭证与当前项目或设备不匹配");
  }

  return {
    ...payload,
    permissions: stringList(payload.permissions),
    device_limit: Number.isSafeInteger(payload.device_limit) ? payload.device_limit : 0,
    shop_limit: Number.isSafeInteger(payload.shop_limit) ? payload.shop_limit : 0,
    expire: new Date(licenseExpire * 1000).toISOString(),
    offline_until: new Date(offlineUntil * 1000).toISOString(),
  };
}
