import crypto from "node:crypto";

export const OZON_PUSH_SINK_PATH = "/api/internal/ozon/push-notifications";
export const OZON_PUSH_SIGNATURE_HEADER = "x-wangzai-ozon-push-signature";

const TYPE_RULES = Object.freeze({
  TYPE_NEW_POSTING: ["orders", "order_new", "新订单", "收到新的待处理订单"],
  TYPE_POSTING_CANCELLED: ["orders", "order_cancelled", "订单取消", "订单已取消"],
  TYPE_STATE_CHANGED: ["orders", "order_status_changed", "订单状态", "订单状态已变化"],
  TYPE_CUTOFF_DATE_CHANGED: ["logistics", "order_cutoff_changed", "备货时限", "订单备货时限已变化"],
  TYPE_DELIVERY_DATE_CHANGED: ["logistics", "order_delivery_date_changed", "送达时间", "订单预计送达时间已变化"],
  TYPE_CREATE_OR_UPDATE_ITEM: ["products", "product_created_or_updated", "商品更新", "商品资料已创建或更新"],
  TYPE_CREATE_ITEM: ["products", "product_created", "商品创建", "商品已创建"],
  TYPE_UPDATE_ITEM: ["products", "product_updated", "商品更新", "商品资料已更新"],
  TYPE_PRICE_INDEX_CHANGED: ["products", "product_price_index_changed", "价格指数", "商品价格指数已变化"],
  TYPE_STOCKS_CHANGED: ["products", "product_stock_changed", "库存变化", "商品库存已变化"],
  TYPE_NEW_MESSAGE: ["customer", "chat_message_new", "买家新消息", "收到买家新消息"],
  TYPE_UPDATE_MESSAGE: ["customer", "chat_message_updated", "消息更新", "买家会话消息已更新"],
  TYPE_MESSAGE_READ: ["customer", "chat_message_read", "消息已读", "买家会话消息已读"],
  TYPE_CHAT_CLOSED: ["customer", "chat_closed", "会话关闭", "买家会话已关闭"],
  TYPE_FBO_POSTING_NEW: ["orders", "fbo_order_new", "FBO 新订单", "收到新的 FBO 订单"],
  TYPE_FBO_POSTING_CANCELLED: ["orders", "fbo_order_cancelled", "FBO 订单取消", "FBO 订单已取消"],
  TYPE_FBO_POSTING_STATE_CHANGED: ["orders", "fbo_order_status_changed", "FBO 订单状态", "FBO 订单状态已变化"],
  TYPE_FBO_POSTING_DELIVERY_DATE_CHANGED: ["logistics", "fbo_delivery_date_changed", "FBO 送达时间", "FBO 订单预计送达时间已变化"],
  TYPE_FBO_STOCKS_CHANGED: ["products", "fbo_stock_changed", "FBO 库存", "FBO 仓库存已变化"],
  TYPE_ORDER_NEW: ["orders", "order_new", "新订单", "收到新的订单"],
  TYPE_ORDER_CANCELLED: ["orders", "order_cancelled", "订单取消", "订单已取消"],
  TYPE_ORDER_STATE_CHANGED: ["orders", "order_status_changed", "订单状态", "订单状态已变化"],
});

function normalizeText(value) {
  if (value === null || value === undefined || typeof value === "object") return "";
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = deepSort(value[key]);
      return result;
    }, {});
}

export function canonicalOzonPushBody(value) {
  return Buffer.from(JSON.stringify(deepSort(value)), "utf8");
}

export function createOzonPushSignature(secret, value, timestamp = Math.floor(Date.now() / 1000)) {
  const body = canonicalOzonPushBody(value);
  const time = String(timestamp);
  const digest = crypto
    .createHmac("sha256", String(secret || ""))
    .update(time, "ascii")
    .update(".", "ascii")
    .update(body)
    .digest("hex");
  return `t=${time},v1=${digest}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyOzonPushSignature({ secret, envelope, signature, now = Date.now(), maxSkewSeconds = 300 }) {
  const parts = Object.fromEntries(
    String(signature || "")
      .split(",")
      .map((part) => part.split("=", 2).map((item) => item.trim()))
      .filter(([key, value]) => key && value),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > maxSkewSeconds) return false;
  const expected = createOzonPushSignature(secret, envelope, timestamp).split("v1=")[1];
  return safeEqual(parts.v1, expected);
}

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || "";
}

function getNestedPayload(payload = {}) {
  const data = asObject(payload.data);
  const posting = asObject(payload.posting || data.posting);
  const order = asObject(payload.order || data.order);
  const item = asObject(payload.item || data.item);
  const message = asObject(payload.message || data.message);
  const stockItems = [payload.items, data.items, payload.stocks, data.stocks]
    .find(Array.isArray) || [];
  const products = [payload.products, data.products, posting.products, order.products]
    .find(Array.isArray) || [];
  return { data, posting, order, item, message, stockItems, products };
}

function resolveSellerId(event = {}) {
  const payload = asObject(event.payload);
  const { data } = getNestedPayload(payload);
  return firstText(
    event.seller_id,
    event.sellerId,
    payload.seller_id,
    payload.sellerId,
    payload.client_id,
    payload.clientId,
    data.seller_id,
    data.sellerId,
    data.client_id,
  );
}

function resolveShop(shopRepository, sellerId) {
  if (!sellerId || !shopRepository?.listShops) return null;
  return (shopRepository.listShops() || []).find(
    (shop) => shop?.status === "active" && normalizeText(shop.clientId || shop.client_id) === sellerId,
  ) || null;
}

function productFacts(payload = {}) {
  const { data, posting, order, item, stockItems, products } = getNestedPayload(payload);
  const firstProduct = asObject(products[0] || stockItems[0]);
  const productId = firstText(
    payload.product_id,
    payload.productId,
    data.product_id,
    item.product_id,
    firstProduct.product_id,
    firstProduct.productId,
  );
  const offerId = firstText(
    payload.offer_id,
    payload.offerId,
    payload.sku,
    data.offer_id,
    data.sku,
    item.offer_id,
    item.sku,
    firstProduct.offer_id,
    firstProduct.sku,
  );
  const name = firstText(
    payload.product_name,
    data.product_name,
    item.name,
    item.title,
    firstProduct.name,
    firstProduct.title,
  );
  const postingNumber = firstText(
    payload.posting_number,
    payload.order_number,
    payload.order_id,
    data.posting_number,
    data.order_number,
    posting.posting_number,
    posting.number,
    order.order_number,
    order.id,
  );
  const productRefs = [
    item,
    ...products,
    ...stockItems,
  ].map((row) => ({
    productId: firstText(row.product_id, row.productId, row.id),
    offerId: firstText(row.offer_id, row.offerId),
    sku: firstText(row.sku, row.sku_id, row.skuId),
  })).concat([{
    productId: firstText(payload.product_id, payload.productId, data.product_id),
    offerId: firstText(payload.offer_id, payload.offerId, data.offer_id),
    sku: firstText(payload.sku, data.sku),
  }]);
  const dedupedProductRefs = new Map();
  productRefs.forEach((ref) => {
    if (!ref.productId && !ref.offerId && !ref.sku) return;
    const key = `${ref.productId}\u0000${ref.offerId}\u0000${ref.sku}`;
    if (!dedupedProductRefs.has(key)) dedupedProductRefs.set(key, ref);
  });
  return {
    productId,
    offerId,
    name,
    postingNumber,
    productCount: products.length || stockItems.length || 0,
    productRefs: [...dedupedProductRefs.values()].slice(0, 100),
  };
}

function chatFacts(payload = {}) {
  const { data, message } = getNestedPayload(payload);
  return {
    chatId: firstText(
      payload.chat_id,
      payload.chatId,
      data.chat_id,
      data.chatId,
      message.chat_id,
      message.chatId,
    ),
    messageId: firstText(
      payload.message_id,
      payload.messageId,
      data.message_id,
      data.messageId,
      message.message_id,
      message.messageId,
      message.id,
    ),
  };
}

function statusFacts(payload = {}) {
  const { data, posting, order } = getNestedPayload(payload);
  return {
    oldStatus: firstText(payload.old_state, payload.old_status, data.old_state, posting.old_state, order.old_state),
    newStatus: firstText(
      payload.new_state,
      payload.new_status,
      payload.state,
      payload.status,
      data.new_state,
      data.status,
      posting.status,
      order.status,
    ),
    reason: firstText(payload.reason, data.reason, posting.reason, order.reason),
    oldDate: firstText(payload.old_date, payload.old_delivery_date, payload.old_cutoff_date, data.old_date),
    newDate: firstText(payload.new_date, payload.new_delivery_date, payload.new_cutoff_date, data.new_date),
  };
}

function humanSummary(baseSummary, facts, status, messageType) {
  const subject = facts.postingNumber
    ? `订单 ${facts.postingNumber}`
    : facts.offerId
      ? `商品 ${facts.offerId}`
      : facts.productId
        ? `商品 ${facts.productId}`
        : "当前店铺";
  if (messageType.includes("MESSAGE") || messageType.includes("CHAT")) return `${subject}：${baseSummary}`;
  if (status.newStatus) return `${subject}：${baseSummary}，当前状态 ${status.newStatus}`;
  if (status.newDate) return `${subject}：${baseSummary}，新时间 ${status.newDate}`;
  return `${subject}：${baseSummary}`;
}

export function normalizeOzonPushEvent(event, shop) {
  const payload = asObject(event?.payload);
  const messageType = firstText(event?.message_type, payload.message_type);
  const rule = TYPE_RULES[messageType] || ["ozon", "ozon_event", "Ozon 通知", "收到一条 Ozon 店铺通知"];
  const [domain, eventType, title, baseSummary] = rule;
  const facts = productFacts(payload);
  const status = statusFacts(payload);
  const chat = chatFacts(payload);
  const entityId = facts.postingNumber || facts.offerId || facts.productId || chat.chatId || chat.messageId;
  return {
    id: `ozon_push_${normalizeText(event.id).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 120)}`,
    shopId: shop.id,
    shopName: firstText(shop.alias, shop.name, shop.clientId),
    domain,
    eventType,
    severity: messageType.includes("CANCELLED") ? "warning" : "info",
    title,
    summary: humanSummary(baseSummary, facts, status, messageType),
    oldValue: {
      status: status.oldStatus || null,
      date: status.oldDate || null,
    },
    newValue: {
      status: status.newStatus || null,
      date: status.newDate || null,
      reason: status.reason || null,
      messageType,
      receivedAt: event.received_at || null,
      productName: facts.name || null,
      sku: facts.offerId || null,
      productId: facts.productId || null,
      productCount: facts.productCount,
      productRefs: facts.productRefs,
      chatId: chat.chatId || null,
      messageId: chat.messageId || null,
    },
    sourceEndpoint: `ozon_push:${messageType}`,
    // Remote push ids are not local scheduler job ids and therefore must not
    // enter the scheduler foreign-key column.
    sourceJobId: null,
    entityType: domain === "customer" ? "chat" : domain === "products" ? "product" : "order",
    entityId: entityId || normalizeText(event.id),
    offerId: facts.offerId || null,
    productId: facts.productId || null,
    postingNumber: facts.postingNumber || null,
    productRefs: facts.productRefs,
    chatId: chat.chatId || null,
    messageId: chat.messageId || null,
  };
}

export function createOzonPushNotificationService({
  db,
  shopRepository,
  notificationService,
  secret,
  onAcceptedEvent,
} = {}) {
  const signingSecret = normalizeText(secret);

  function ingestEnvelope(envelope, signature, options = {}) {
    if (signingSecret.length < 32) {
      return { ok: false, statusCode: 503, error: { code: "OZON_PUSH_SINK_NOT_CONFIGURED", message: "Ozon 推送接收密钥未配置。" } };
    }
    if (!verifyOzonPushSignature({ secret: signingSecret, envelope, signature, now: options.now })) {
      return { ok: false, statusCode: 401, error: { code: "OZON_PUSH_SIGNATURE_INVALID", message: "Ozon 推送签名校验失败。" } };
    }
    const events = Array.isArray(envelope?.events) ? envelope.events.slice(0, 200) : [];
    const accepted = [];
    const deduped = [];
    const rejected = [];
    const followUp = [];
    for (const event of events) {
      const remoteId = normalizeText(event?.id);
      if (!remoteId) {
        rejected.push({ id: "", code: "OZON_PUSH_EVENT_ID_MISSING" });
        continue;
      }
      const localId = `ozon_push_${remoteId.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 120)}`;
      if (db?.prepare("SELECT id FROM ozon_notification_events WHERE id = ?").get(localId)) {
        deduped.push(remoteId);
        continue;
      }
      const sellerId = resolveSellerId(event);
      const shop = resolveShop(shopRepository, sellerId);
      if (!shop) {
        rejected.push({ id: remoteId, code: sellerId ? "OZON_PUSH_SHOP_NOT_FOUND" : "OZON_PUSH_SELLER_ID_MISSING" });
        continue;
      }
      const normalized = normalizeOzonPushEvent(event, shop);
      const recorded = notificationService?.recordNotification?.(normalized);
      if (!recorded || recorded.skipped) {
        rejected.push({ id: remoteId, code: "OZON_PUSH_NOTIFICATION_NOT_RECORDED" });
        continue;
      }
      if (recorded.deduped) deduped.push(remoteId);
      else {
        accepted.push(remoteId);
        if (typeof onAcceptedEvent === "function") {
          try {
            const scheduled = onAcceptedEvent({ remoteId, event, shop, normalized });
            if (scheduled) followUp.push({ id: remoteId, ...scheduled });
          } catch (error) {
            followUp.push({
              id: remoteId,
              queued: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    return { ok: true, statusCode: 200, accepted, deduped, rejected, followUp };
  }

  return { ingestEnvelope };
}

export const ozonPushTypeRules = TYPE_RULES;
