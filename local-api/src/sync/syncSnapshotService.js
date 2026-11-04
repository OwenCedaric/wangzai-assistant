import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function nullableText(value) {
  const text = normalizeText(value);
  return text || null;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function compactJson(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(null);
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampLimit(value, fallback = 50, max = 200) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.trunc(number), max);
}

function normalizeEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = normalizeText(value).toLowerCase();
  if (["1", "true", "yes", "on", "开启", "启用"].includes(text)) return true;
  if (["0", "false", "no", "off", "关闭", "禁用"].includes(text)) return false;
  return fallback;
}

function normalizeReadFilter(value) {
  const text = normalizeText(value).toLowerCase();
  if (["unread", "false", "0", "未读"].includes(text)) return "unread";
  if (["read", "true", "1", "已读"].includes(text)) return "read";
  return "";
}

function minutesAgoIso(minutes) {
  return new Date(
    Date.now() - Math.max(0, Number(minutes) || 0) * 60 * 1000,
  ).toISOString();
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return normalizeText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasTable(db, tableName) {
  try {
    return Boolean(
      db
        ?.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(tableName),
    );
  } catch {
    return false;
  }
}

function toPublicSnapshot(row = {}) {
  return {
    id: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    source: row.source,
    status: row.status,
    active: Boolean(row.active),
    rowCount: row.row_count || 0,
    changedCount: row.changed_count || 0,
    unchangedCount: row.unchanged_count || 0,
    failedCount: row.failed_count || 0,
    sourceJobId: row.source_job_id || null,
    createdAt: row.created_at,
    activatedAt: row.activated_at || null,
    finishedAt: row.finished_at || null,
  };
}

function toPublicNotification(row = {}) {
  return {
    id: row.id,
    shopId: row.shop_id || null,
    shopName: row.shop_name || "",
    domain: row.domain,
    eventType: row.event_type,
    severity: row.severity || "info",
    title: row.title || "",
    summary: row.summary || "",
    oldValue: parseJson(row.old_value_json, null),
    newValue: parseJson(row.new_value_json, null),
    sourceEndpoint: row.source_endpoint || null,
    sourceJobId: row.source_job_id || null,
    sourceAttemptId: row.source_attempt_id || null,
    snapshotId: row.snapshot_id || null,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    offerId: row.offer_id || null,
    productId: row.product_id || null,
    postingNumber: row.posting_number || null,
    enabled: row.enabled !== 0,
    readAt: row.read_at || null,
    createdAt: row.created_at,
  };
}

function toPublicSetting(row = {}) {
  return {
    id: row.id,
    shopId: row.shop_id || null,
    shopScope: row.shop_scope || "all",
    domain: row.domain,
    eventType: row.event_type,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_NOTIFICATION_CATALOG = Object.freeze([
  {
    domain: "products",
    title: "商品信息",
    eventTypes: [
      "product_status_changed",
      "product_price_changed",
      "product_stock_zero",
      "product_stock_low",
      "product_created",
      "product_updated",
      "product_created_or_updated",
      "product_price_index_changed",
      "product_stock_changed",
      "fbo_stock_changed",
    ],
  },
  {
    domain: "orders",
    title: "订单信息",
    eventTypes: [
      "order_new",
      "order_paid",
      "order_status_changed",
      "order_cancelled",
      "fbo_order_new",
      "fbo_order_cancelled",
      "fbo_order_status_changed",
    ],
  },
  {
    domain: "customer",
    title: "买家消息",
    eventTypes: [
      "chat_message_new",
      "chat_message_updated",
      "chat_message_read",
      "chat_closed",
    ],
  },
  {
    domain: "returns",
    title: "售后信息",
    eventTypes: ["return_created", "return_status_changed"],
  },
  {
    domain: "marketing",
    title: "营销信息",
    eventTypes: ["marketing_activity_changed", "marketing_price_changed"],
  },
  {
    domain: "performance",
    title: "付费推广信息",
    eventTypes: [
      "performance_budget_exhausted",
      "performance_moderation_rejected",
    ],
  },
  {
    domain: "purchase",
    title: "拍单信息",
    eventTypes: ["purchase_source_missing", "purchase_order_changed"],
  },
  {
    domain: "profit",
    title: "利润信息",
    eventTypes: ["profit_penalty_changed", "profit_finance_changed"],
  },
  {
    domain: "logistics",
    title: "物流信息",
    eventTypes: [
      "logistics_status_changed",
      "order_cutoff_changed",
      "order_delivery_date_changed",
      "fbo_delivery_date_changed",
    ],
  },
  {
    domain: "finance",
    title: "财务信息",
    eventTypes: ["finance_transaction_changed"],
  },
]);

export function createSyncSnapshotService(db) {
  const hasSnapshotsTable = hasTable(db, "ozon_sync_snapshots");
  const hasNotificationsTable = hasTable(db, "ozon_notification_events");
  const hasNotificationSettingsTable = hasTable(
    db,
    "ozon_notification_settings",
  );

  function getSnapshot(snapshotId) {
    if (!hasSnapshotsTable || !snapshotId) return null;
    const row = db
      .prepare("SELECT * FROM ozon_sync_snapshots WHERE id = ?")
      .get(snapshotId);
    return row ? toPublicSnapshot(row) : null;
  }

  function isNotificationEnabled(input = {}) {
    if (!hasNotificationSettingsTable) return true;
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const shopScope = shopId || "all";
    const domain = normalizeText(input.domain || "unknown");
    const eventType = normalizeText(
      (input.eventType ?? input.event_type) || "*",
    );
    const row = db
      .prepare(
        `
        SELECT enabled
        FROM ozon_notification_settings
        WHERE shop_scope IN (?, 'all')
          AND domain IN (?, '*')
          AND event_type IN (?, '*')
        ORDER BY
          CASE WHEN shop_scope = ? THEN 0 ELSE 1 END,
          CASE WHEN domain = ? THEN 0 ELSE 1 END,
          CASE WHEN event_type = ? THEN 0 ELSE 1 END
        LIMIT 1
      `,
      )
      .get(shopScope, domain, eventType, shopScope, domain, eventType);
    return row ? row.enabled !== 0 : true;
  }

  function buildNotificationWhere(query = {}) {
    const where = ["enabled = 1"];
    const params = [];
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const shopIds = splitIds(query.shopIds ?? query.shop_ids);
    const domain = normalizeText(query.domain);
    const eventType = normalizeText(query.eventType ?? query.event_type);
    const severity = normalizeText(query.severity);
    const readFilter = normalizeReadFilter(query.read ?? query.status);
    if (shopId && shopId !== "all") {
      where.push("shop_id = ?");
      params.push(shopId);
    } else if (shopIds.length) {
      where.push(`shop_id IN (${shopIds.map(() => "?").join(",")})`);
      params.push(...shopIds);
    }
    if (domain && domain !== "all") {
      where.push("domain = ?");
      params.push(domain);
    }
    if (eventType && eventType !== "all") {
      where.push("event_type = ?");
      params.push(eventType);
    }
    if (severity && severity !== "all") {
      where.push("severity = ?");
      params.push(severity);
    }
    if (readFilter === "read") where.push("read_at IS NOT NULL");
    if (readFilter === "unread") where.push("read_at IS NULL");
    return { clause: `WHERE ${where.join(" AND ")}`, params };
  }

  function applySettingToUnreadEvents(input = {}) {
    if (!hasNotificationsTable) return 0;
    const enabled = normalizeEnabled(input.enabled);
    if (enabled) return 0;
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const domain = normalizeText(input.domain || "*");
    const eventType = normalizeText(
      (input.eventType ?? input.event_type) || "*",
    );
    const where = ["read_at IS NULL", "enabled = 1"];
    const params = [];
    if (shopId) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (domain !== "*") {
      where.push("domain = ?");
      params.push(domain);
    }
    if (eventType !== "*") {
      where.push("event_type = ?");
      params.push(eventType);
    }
    return db
      .prepare(
        `UPDATE ozon_notification_events SET enabled = 0 WHERE ${where.join(" AND ")}`,
      )
      .run(...params).changes;
  }

  return {
    isAvailable() {
      return hasSnapshotsTable && hasNotificationsTable;
    },

    isNotificationEnabled,

    createSnapshot(input = {}) {
      if (!hasSnapshotsTable) return null;
      const timestamp = nowIso();
      const id = input.id || `sync_snapshot_${randomUUID()}`;
      db.prepare(
        `
        INSERT INTO ozon_sync_snapshots (
          id, domain, shop_id, source, status, active, row_count,
          changed_count, unchanged_count, failed_count, source_job_id,
          created_at, activated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, NULL, NULL)
      `,
      ).run(
        id,
        normalizeText(input.domain || "unknown"),
        nullableText(input.shopId ?? input.shop_id),
        normalizeText(input.source || "unknown"),
        normalizeText(input.status || "running"),
        nullableText(input.sourceJobId ?? input.source_job_id),
        timestamp,
      );
      return getSnapshot(id);
    },

    finishSnapshot(snapshotId, patch = {}) {
      if (!hasSnapshotsTable || !snapshotId) return null;
      const existing = getSnapshot(snapshotId);
      if (!existing) return null;
      const timestamp = nowIso();
      const shouldActivate = patch.active === true;
      if (shouldActivate) {
        db.prepare(
          `
          UPDATE ozon_sync_snapshots
          SET active = 0
          WHERE domain = ?
            AND COALESCE(shop_id, '') = COALESCE(?, '')
            AND id <> ?
        `,
        ).run(existing.domain, existing.shopId, snapshotId);
      }
      db.prepare(
        `
        UPDATE ozon_sync_snapshots
        SET status = ?, active = ?, row_count = ?, changed_count = ?,
            unchanged_count = ?, failed_count = ?, activated_at = ?,
            finished_at = ?
        WHERE id = ?
      `,
      ).run(
        normalizeText(patch.status || existing.status),
        shouldActivate ? 1 : 0,
        toInteger(patch.rowCount ?? existing.rowCount),
        toInteger(patch.changedCount ?? existing.changedCount),
        toInteger(patch.unchangedCount ?? existing.unchangedCount),
        toInteger(patch.failedCount ?? existing.failedCount),
        shouldActivate ? timestamp : existing.activatedAt,
        timestamp,
        snapshotId,
      );
      return getSnapshot(snapshotId);
    },

    recordNotification(input = {}) {
      if (!hasNotificationsTable) return null;
      if (!isNotificationEnabled(input)) {
        return {
          skipped: true,
          reason: "notification_disabled",
        };
      }
      const shopId = nullableText(input.shopId ?? input.shop_id);
      const shopName = nullableText(input.shopName ?? input.shop_name);
      const domain = normalizeText(input.domain || "unknown");
      const eventType = normalizeText(input.eventType ?? input.event_type);
      const severity = normalizeText(input.severity || "info");
      const title = normalizeText(input.title || "同步变化");
      const summary = nullableText(input.summary);
      const oldValueJson = compactJson(input.oldValue ?? input.old_value);
      const newValueJson = compactJson(input.newValue ?? input.new_value);
      const sourceEndpoint = nullableText(
        input.sourceEndpoint ?? input.source_endpoint,
      );
      const sourceJobId = nullableText(
        input.sourceJobId ?? input.source_job_id,
      );
      const sourceAttemptId = nullableText(
        input.sourceAttemptId ?? input.source_attempt_id,
      );
      const snapshotId = nullableText(input.snapshotId ?? input.snapshot_id);
      const entityType = nullableText(input.entityType ?? input.entity_type);
      const entityId = nullableText(input.entityId ?? input.entity_id);
      const offerId = nullableText(input.offerId ?? input.offer_id);
      const productId = nullableText(input.productId ?? input.product_id);
      const postingNumber = nullableText(
        input.postingNumber ?? input.posting_number,
      );
      const dedupeSince = minutesAgoIso(input.dedupeWindowMinutes ?? 10);
      const duplicate = db
        .prepare(
          `
          SELECT id, created_at
          FROM ozon_notification_events
          WHERE enabled = 1
            AND COALESCE(shop_id, '') = COALESCE(?, '')
            AND domain = ?
            AND event_type = ?
            AND COALESCE(entity_type, '') = COALESCE(?, '')
            AND COALESCE(entity_id, '') = COALESCE(?, '')
            AND COALESCE(offer_id, '') = COALESCE(?, '')
            AND COALESCE(product_id, '') = COALESCE(?, '')
            AND COALESCE(posting_number, '') = COALESCE(?, '')
            AND COALESCE(summary, '') = COALESCE(?, '')
            AND COALESCE(old_value_json, '') = COALESCE(?, '')
            AND COALESCE(new_value_json, '') = COALESCE(?, '')
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get(
          shopId,
          domain,
          eventType,
          entityType,
          entityId,
          offerId,
          productId,
          postingNumber,
          summary,
          oldValueJson,
          newValueJson,
          dedupeSince,
        );
      if (duplicate) {
        return {
          id: duplicate.id,
          createdAt: duplicate.created_at,
          deduped: true,
        };
      }
      const id = input.id || `notification_${randomUUID()}`;
      const timestamp = nowIso();
      db.prepare(
        `
        INSERT INTO ozon_notification_events (
          id, shop_id, shop_name, domain, event_type, severity, title, summary,
          old_value_json, new_value_json, source_endpoint, source_job_id,
          source_attempt_id, snapshot_id, entity_type, entity_id, offer_id,
          product_id, posting_number, enabled, read_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `,
      ).run(
        id,
        shopId,
        shopName,
        domain,
        eventType,
        severity,
        title,
        summary,
        oldValueJson,
        newValueJson,
        sourceEndpoint,
        sourceJobId,
        sourceAttemptId,
        snapshotId,
        entityType,
        entityId,
        offerId,
        productId,
        postingNumber,
        input.enabled === false ? 0 : 1,
        timestamp,
      );
      return { id, createdAt: timestamp };
    },

    listNotifications(query = {}) {
      if (!hasNotificationsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_EVENTS_NOT_CONNECTED",
            message: "提醒事件表尚未连接。",
          },
        };
      }
      const limit = clampLimit(query.limit ?? query.pageSize, 50, 200);
      const page = Math.max(toInteger(query.page, 1), 1);
      const offset = Math.max(toInteger(query.offset, (page - 1) * limit), 0);
      const { clause, params } = buildNotificationWhere(query);
      const total = db
        .prepare(
          `SELECT COUNT(*) AS total FROM ozon_notification_events ${clause}`,
        )
        .get(...params)?.total;
      const unread = db
        .prepare(
          `SELECT COUNT(*) AS total FROM ozon_notification_events ${clause} AND read_at IS NULL`,
        )
        .get(...params)?.total;
      const rows = db
        .prepare(
          `
          SELECT *
          FROM ozon_notification_events
          ${clause}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(...params, limit, offset);
      return {
        ok: true,
        domain: query.domain || "all",
        source: "sqlite",
        rows: rows.map(toPublicNotification),
        total: Number(total) || 0,
        unread: Number(unread) || 0,
        page,
        pageSize: limit,
        offset,
      };
    },

    listObservedPushBindings(query = {}) {
      if (!hasNotificationsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_EVENTS_NOT_CONNECTED",
            message: "提醒事件表尚未连接。",
          },
        };
      }
      const domain = normalizeText(query.domain || "customer");
      const where = [
        "shop_id IS NOT NULL",
        "TRIM(shop_id) <> ''",
        "source_endpoint LIKE 'ozon_push:%'",
      ];
      const params = [];
      const shopIds = splitIds(query.shopIds ?? query.shop_ids);
      if (shopIds.length) {
        where.push(`shop_id IN (${shopIds.map(() => "?").join(",")})`);
        params.push(...shopIds);
      }
      if (domain && domain !== "all") {
        where.push("domain = ?");
        params.push(domain);
      }
      const rows = db
        .prepare(
          `
          SELECT
            shop_id,
            MAX(shop_name) AS shop_name,
            COUNT(*) AS event_count,
            MAX(created_at) AS last_event_at
          FROM ozon_notification_events
          WHERE ${where.join(" AND ")}
          GROUP BY shop_id
          ORDER BY last_event_at DESC, shop_id ASC
        `,
        )
        .all(...params)
        .map((row) => ({
          shopId: row.shop_id,
          shopName: row.shop_name || null,
          eventCount: Number(row.event_count) || 0,
          lastEventAt: row.last_event_at || null,
        }));
      return {
        ok: true,
        source: "sqlite",
        domain: domain || "all",
        rows,
        shopIds: rows.map((row) => row.shopId),
      };
    },

    markNotificationsRead(input = {}) {
      if (!hasNotificationsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_EVENTS_NOT_CONNECTED",
            message: "提醒事件表尚未连接。",
          },
        };
      }
      const ids = splitIds(input.ids ?? input.id);
      const timestamp = nowIso();
      if (ids.length) {
        const result = db
          .prepare(
            `
            UPDATE ozon_notification_events
            SET read_at = COALESCE(read_at, ?)
            WHERE id IN (${ids.map(() => "?").join(",")})
              AND enabled = 1
          `,
          )
          .run(timestamp, ...ids);
        return { ok: true, updated: result.changes || 0, readAt: timestamp };
      }
      const { clause, params } = buildNotificationWhere({
        ...input,
        read: "unread",
      });
      const result = db
        .prepare(
          `
          UPDATE ozon_notification_events
          SET read_at = COALESCE(read_at, ?)
          ${clause}
        `,
        )
        .run(timestamp, ...params);
      return { ok: true, updated: result.changes || 0, readAt: timestamp };
    },

    clearNotifications(input = {}) {
      if (!hasNotificationsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_EVENTS_NOT_CONNECTED",
            message: "提醒事件表尚未连接。",
          },
        };
      }
      const ids = splitIds(input.ids ?? input.id);
      if (ids.length) {
        const result = db
          .prepare(
            `
            UPDATE ozon_notification_events
            SET enabled = 0
            WHERE id IN (${ids.map(() => "?").join(",")})
              AND enabled = 1
          `,
          )
          .run(...ids);
        return { ok: true, cleared: result.changes || 0 };
      }
      const { clause, params } = buildNotificationWhere(input);
      const result = db
        .prepare(
          `
          UPDATE ozon_notification_events
          SET enabled = 0
          ${clause}
        `,
        )
        .run(...params);
      return { ok: true, cleared: result.changes || 0 };
    },

    listNotificationSettings(query = {}) {
      if (!hasNotificationSettingsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_SETTINGS_NOT_CONNECTED",
            message: "提醒设置表尚未连接。",
          },
        };
      }
      const where = [];
      const params = [];
      const shopId = normalizeText(query.shopId ?? query.shop_id);
      const domain = normalizeText(query.domain);
      if (shopId && shopId !== "all") {
        where.push("shop_scope IN (?, 'all')");
        params.push(shopId);
      }
      if (domain && domain !== "all") {
        where.push("domain = ?");
        params.push(domain);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `
          SELECT *
          FROM ozon_notification_settings
          ${clause}
          ORDER BY shop_scope, domain, event_type
        `,
        )
        .all(...params);
      return {
        ok: true,
        source: "sqlite",
        catalog: DEFAULT_NOTIFICATION_CATALOG,
        rows: rows.map(toPublicSetting),
      };
    },

    saveNotificationSetting(input = {}) {
      if (!hasNotificationSettingsTable) {
        return {
          ok: false,
          error: {
            code: "NOTIFICATION_SETTINGS_NOT_CONNECTED",
            message: "提醒设置表尚未连接。",
          },
        };
      }
      const shopId = normalizeText(input.shopId ?? input.shop_id);
      const shopScope = shopId || "all";
      const domain = normalizeText(input.domain || "*");
      const eventType = normalizeText(
        (input.eventType ?? input.event_type) || "*",
      );
      const enabled = normalizeEnabled(input.enabled);
      const timestamp = nowIso();
      const id = input.id || `notification_setting_${randomUUID()}`;
      db.prepare(
        `
        INSERT INTO ozon_notification_settings (
          id, shop_id, shop_scope, domain, event_type, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop_scope, domain, event_type) DO UPDATE SET
          shop_id = excluded.shop_id,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        nullableText(shopId),
        shopScope,
        domain,
        eventType,
        enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
      const hiddenExisting = applySettingToUnreadEvents({
        shopId,
        domain,
        eventType,
        enabled,
      });
      const row = db
        .prepare(
          "SELECT * FROM ozon_notification_settings WHERE shop_scope = ? AND domain = ? AND event_type = ?",
        )
        .get(shopScope, domain, eventType);
      return {
        ok: true,
        setting: toPublicSetting(row),
        hiddenExisting,
      };
    },
  };
}
