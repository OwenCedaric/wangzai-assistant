import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function decodeBase64(value) {
  const normalized = normalizeText(value).replace(/^data:[^;]+;base64,/u, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    const error = new Error("附件内容不是有效的 Base64。");
    error.code = "CUSTOMER_FILE_BASE64_INVALID";
    throw error;
  }
  return Buffer.from(normalized, "base64");
}

export function createCustomerOutboundFileStore({
  ttlMs = DEFAULT_TTL_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const files = new Map();

  function prune() {
    const now = Date.now();
    for (const [token, row] of files.entries()) {
      if (row.expiresAtMs <= now || row.consumed) files.delete(token);
    }
  }

  function stage(input = {}) {
    prune();
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const chatId = normalizeText(input.chatId ?? input.chat_id);
    const name = normalizeText(input.name)
      .replace(/[\\/\0]/gu, "_")
      .slice(0, 180);
    const mimeType = normalizeText(input.mimeType ?? input.mime_type).slice(
      0,
      120,
    );
    if (!shopId || !chatId || !name) {
      const error = new Error("发送附件必须包含店铺、会话和文件名。");
      error.code = "CUSTOMER_FILE_SCOPE_REQUIRED";
      throw error;
    }
    const bytes = decodeBase64(input.base64Content ?? input.base64_content);
    if (!bytes.length || bytes.length > maxBytes) {
      const error = new Error(
        `附件大小必须在 1 字节至 ${Math.floor(maxBytes / 1024 / 1024)} MB 之间。`,
      );
      error.code = "CUSTOMER_FILE_SIZE_INVALID";
      error.statusCode = bytes.length > maxBytes ? 413 : 400;
      throw error;
    }
    const handle = `customer-file-${randomUUID()}`;
    const row = Object.freeze({
      token: handle,
      shopId,
      chatId,
      name,
      mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64Content: bytes.toString("base64"),
      createdAt: new Date().toISOString(),
      expiresAtMs: Date.now() + ttlMs,
      consumed: false,
    });
    files.set(handle, row);
    return {
      token: handle,
      shopId,
      chatId,
      name,
      mimeType,
      size: row.size,
      sha256: row.sha256,
      expiresAt: new Date(row.expiresAtMs).toISOString(),
    };
  }

  function resolve({ token, shopId, chatId } = {}) {
    prune();
    const row = files.get(normalizeText(token));
    if (!row || row.consumed || row.expiresAtMs <= Date.now()) {
      const error = new Error("附件暂存已过期，请重新选择文件。");
      error.code = "CUSTOMER_FILE_STAGE_EXPIRED";
      throw error;
    }
    if (
      row.shopId !== normalizeText(shopId) ||
      row.chatId !== normalizeText(chatId)
    ) {
      const error = new Error("附件所属店铺或会话已变化，请重新选择文件。");
      error.code = "CUSTOMER_FILE_SCOPE_MISMATCH";
      throw error;
    }
    return row;
  }

  function consume(token) {
    const normalizedToken = normalizeText(token);
    const row = files.get(normalizedToken);
    if (row) files.delete(normalizedToken);
  }

  return { stage, resolve, consume, prune };
}
