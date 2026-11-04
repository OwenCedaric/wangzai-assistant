import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app/createApp.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import { createSyncSnapshotService } from "../src/sync/syncSnapshotService.js";
import { createMigratedTestDb, saveUnitShop } from "./testDb.js";

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: {
      async requestReadOnly() {
        throw new Error("notification route tests must not call Ozon");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("notification service respects shop/domain/event settings before recording events", () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_notifications_service");
    const service = createSyncSnapshotService(db);

    const disabled = service.saveNotificationSetting({
      shopId,
      domain: "products",
      eventType: "product_stock_low",
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.setting.enabled, false);

    const skipped = service.recordNotification({
      shopId,
      domain: "products",
      eventType: "product_stock_low",
      severity: "warning",
      title: "商品库存偏低",
    });
    assert.equal(skipped.skipped, true);
    assert.equal(service.listNotifications({ shopId }).total, 0);

    const recorded = service.recordNotification({
      shopId,
      domain: "products",
      eventType: "product_price_changed",
      title: "商品价格变化",
      summary: "offer-1：100 -> 90",
      offerId: "offer-1",
    });
    assert.equal(Boolean(recorded.id), true);
    assert.equal(service.listNotifications({ shopId }).total, 1);

    const duplicate = service.recordNotification({
      shopId,
      domain: "products",
      eventType: "product_price_changed",
      title: "商品价格变化",
      summary: "offer-1：100 -> 90",
      offerId: "offer-1",
    });
    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.id, recorded.id);
    assert.equal(service.listNotifications({ shopId }).total, 1);

    const hidden = service.saveNotificationSetting({
      shopId,
      domain: "products",
      eventType: "product_price_changed",
      enabled: false,
    });
    assert.equal(hidden.hiddenExisting, 1);
    assert.equal(service.listNotifications({ shopId }).total, 0);
  } finally {
    db.close();
  }
});

test("notification routes expose events, settings and mark-read flow", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_notifications_routes");
    const service = createSyncSnapshotService(db);
    const recorded = service.recordNotification({
      shopId,
      shopName: "通知测试店铺",
      domain: "products",
      eventType: "product_status_changed",
      title: "商品状态变化",
      summary: "offer-route：出售中 -> 已下架",
      offerId: "offer-route",
      productId: "product-route",
    });

    await withServer(db, async (base) => {
      const notifications = await (
        await fetch(
          `${base}/api/ozon/notifications?shopId=${shopId}&domain=products&read=unread`,
        )
      ).json();
      assert.equal(notifications.ok, true);
      assert.equal(notifications.total, 1);
      assert.equal(notifications.unread, 1);
      assert.equal(notifications.rows[0].id, recorded.id);
      assert.equal(notifications.rows[0].offerId, "offer-route");

      const savedSetting = await (
        await fetch(`${base}/api/ozon/notification-settings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shopId,
            domain: "products",
            eventType: "product_stock_zero",
            enabled: false,
          }),
        })
      ).json();
      assert.equal(savedSetting.ok, true);
      assert.equal(savedSetting.setting.enabled, false);

      const settings = await (
        await fetch(`${base}/api/ozon/notification-settings?shopId=${shopId}`)
      ).json();
      assert.equal(settings.ok, true);
      assert.equal(settings.catalog.some((item) => item.domain === "products"), true);
      assert.equal(
        settings.rows.some(
          (row) =>
            row.shopId === shopId &&
            row.domain === "products" &&
            row.eventType === "product_stock_zero" &&
            row.enabled === false,
        ),
        true,
      );

      const readResult = await (
        await fetch(`${base}/api/ozon/notifications/read`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [recorded.id] }),
        })
      ).json();
      assert.equal(readResult.ok, true);
      assert.equal(readResult.updated, 1);

      const unreadAfter = await (
        await fetch(
          `${base}/api/ozon/notifications?shopId=${shopId}&domain=products&read=unread`,
        )
      ).json();
      assert.equal(unreadAfter.total, 0);

      const allAfterRead = await (
        await fetch(
          `${base}/api/ozon/notifications?shopId=${shopId}&domain=products`,
        )
      ).json();
      assert.equal(allAfterRead.total, 1);
      assert.equal(allAfterRead.unread, 0);
      assert.equal(Boolean(allAfterRead.rows[0].readAt), true);

      const clearResult = await (
        await fetch(`${base}/api/ozon/notifications/clear`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shopId, domain: "products" }),
        })
      ).json();
      assert.equal(clearResult.ok, true);
      assert.equal(clearResult.cleared, 1);

      const allAfterClear = await (
        await fetch(
          `${base}/api/ozon/notifications?shopId=${shopId}&domain=products`,
        )
      ).json();
      assert.equal(allAfterClear.total, 0);
    });
  } finally {
    db.close();
  }
});
