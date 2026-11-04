import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function text(value) {
  return String(value ?? "").trim();
}

function sourceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPrivateAddress(address) {
  if (
    !address ||
    address === "::1" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  ) {
    return true;
  }
  if (!isIP(address)) return true;
  if (address.includes(":")) return false;
  const parts = address.split(".").map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function detectedMimeType(data) {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

function validateImageBytes(data, declaredMimeType) {
  if (!Buffer.isBuffer(data) || !data.length || data.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw sourceError("IMAGE_MODEL_SOURCE_INVALID", "参考图片为空或超过 10MB。");
  }
  const actualMimeType = detectedMimeType(data);
  if (!ALLOWED_MIME_TYPES.has(declaredMimeType) || actualMimeType !== declaredMimeType) {
    throw sourceError(
      "IMAGE_MODEL_SOURCE_INVALID",
      "参考图片只支持真实的 PNG、JPEG 或 WebP 文件。",
    );
  }
  return { data, mimeType: actualMimeType };
}

function decodeDataImage(value) {
  const match = text(value).match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u,
  );
  if (!match) return null;
  return validateImageBytes(Buffer.from(match[2], "base64"), match[1]);
}

async function assertPublicHttpsUrl(value, lookupImpl) {
  let url;
  try {
    url = new URL(text(value));
  } catch (error) {
    throw sourceError("IMAGE_MODEL_SOURCE_INVALID", "参考图片地址无效。", error);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw sourceError(
      "IMAGE_MODEL_SOURCE_INVALID",
      "参考图片必须使用无账号信息的 HTTPS 地址。",
    );
  }
  const addresses = await lookupImpl(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw sourceError(
      "IMAGE_MODEL_SOURCE_INVALID",
      "参考图片不能指向本机或内网。",
    );
  }
  return url;
}

async function downloadSourceImage(
  value,
  { fetchImpl, lookupImpl, signal, redirects = 0 } = {},
) {
  const inline = decodeDataImage(value);
  if (inline) return inline;
  if (redirects > MAX_REDIRECTS) {
    throw sourceError("IMAGE_MODEL_SOURCE_INVALID", "参考图片重定向次数过多。");
  }
  const url = await assertPublicHttpsUrl(value, lookupImpl);
  let response;
  try {
    response = await fetchImpl(url, { redirect: "manual", signal });
  } catch (error) {
    throw sourceError(
      "IMAGE_MODEL_SOURCE_UNAVAILABLE",
      "参考图片暂时无法读取。",
      error,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    await response.body?.cancel?.().catch(() => undefined);
    if (!location) {
      throw sourceError(
        "IMAGE_MODEL_SOURCE_INVALID",
        "参考图片重定向缺少目标地址。",
      );
    }
    return downloadSourceImage(new URL(location, url).toString(), {
      fetchImpl,
      lookupImpl,
      signal,
      redirects: redirects + 1,
    });
  }
  if (!response.ok) {
    throw sourceError(
      "IMAGE_MODEL_SOURCE_UNAVAILABLE",
      `参考图片读取失败：HTTP ${response.status}。`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > MAX_SOURCE_IMAGE_BYTES) {
    throw sourceError("IMAGE_MODEL_SOURCE_INVALID", "参考图片超过 10MB。");
  }
  const mimeType = text(response.headers.get("content-type"))
    .split(";", 1)[0]
    .toLowerCase();
  const data = Buffer.from(await response.arrayBuffer());
  return validateImageBytes(data, mimeType);
}

export function createProductImageModelSourceStager({
  fetchImpl = fetch,
  lookupImpl = lookup,
} = {}) {
  async function stage({ sourceImages = [], shopId, signal } = {}) {
    const normalizedShopId = text(shopId);
    if (!normalizedShopId || normalizedShopId === "shop-unbound") {
      throw sourceError(
        "IMAGE_MODEL_SOURCE_SHOP_REQUIRED",
        "当前没有有效店铺，不能准备参考图片。",
      );
    }
    const prepared = [];
    for (const value of sourceImages) {
      const source = await downloadSourceImage(value, {
        fetchImpl,
        lookupImpl,
        signal,
      });
      prepared.push(
        `data:${source.mimeType};base64,${source.data.toString("base64")}`,
      );
    }
    return { sourceImages: prepared, cleanup: async () => {} };
  }

  return Object.freeze({ stage });
}
