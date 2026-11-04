import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app/createApp.js";
import { createCrossBorderOrderRepository } from "../src/db/repositories/crossBorderOrderRepository.js";
import { createPurchaseOrderOverrideRepository } from "../src/db/repositories/purchaseOrderOverrideRepository.js";
import { createMigratedTestDb } from "./testDb.js";

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: {
      async requestReadOnly() {
        throw new Error("purchase override tests must not call Ozon");
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

test("purchase order override repository saves manual purchase fields in SQLite", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    const saved = repository.upsertOverride({
      shopId: "shop-po1",
      postingNumber: "posting-1",
      purchasePlatform: "PDD",
      purchaseOrderNumber: "pdd-001",
      purchaseOrderUrl:
        "https://mms.pinduoduo.com/orders/detail?orderSn=pdd-001",
      sourceCostCny: 12.34,
      manualStatus: "已拍单-待预报",
    });
    assert.equal(saved.ok, true);
    const page = repository.listOverrides({ shopId: "shop-po1" });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].purchasePlatform, "PDD");
    assert.equal(page.rows[0].purchaseOrderNumber, "pdd-001");
    assert.equal(
      page.rows[0].purchaseOrderUrl,
      "https://mms.pinduoduo.com/orders/detail?orderSn=pdd-001",
    );
    assert.equal(page.rows[0].sourceCostCny, 12.34);
  } finally {
    db.close();
  }
});

test("purchase order override repository rejects writes without a scoped internal shop id", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    assert.throws(
      () => repository.upsertOverride({
        orderKey: "posting-empty-shop-1",
        postingNumber: "posting-empty-shop-1",
        raw: { manualBuyerPlatform: "PDD" },
      }),
      /PURCHASE_OVERRIDE_SHOP_SCOPE_REQUIRED/,
    );
    assert.throws(
      () => repository.upsertOverride({
        shopId: "default",
        orderKey: "posting-default-shop-1",
      }),
      /PURCHASE_OVERRIDE_SHOP_SCOPE_REQUIRED/,
    );
    assert.equal(repository.listOverrides({}).total, 0);
  } finally {
    db.close();
  }
});

test("purchase clearFields clears SQLite columns and round-trips only until cleanup", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    repository.upsertOverride({
      shopId: "shop-po-clear",
      orderKey: "client-po-clear:posting-clear-1",
      postingNumber: "client-po-clear:posting-clear-1",
      purchasePlatform: "1688",
      purchaseOrderNumber: "purchase-clear-1",
      purchaseOrderUrl: "https://detail.example/purchase-clear-1",
      sourceCostCny: 22.5,
      manualStatus: "已付款",
      raw: {
        packageOrderId: "bus-clear-1",
        manualProfitLogisticsFeeCny: 3.2,
      },
    });

    const cleared = repository.upsertOverride({
      shopId: "shop-po-clear",
      orderKey: "client-po-clear:posting-clear-1",
      postingNumber: "client-po-clear:posting-clear-1",
      purchasePlatform: "stale-value-must-not-win",
      purchaseOrderNumber: "stale-value-must-not-win",
      sourceCostCny: 99,
      clearFields: [
        "purchasePlatform",
        "purchaseOrderNumber",
        "purchaseOrderUrl",
        "sourceCostCny",
        "manualStatus",
        "notAllowed",
      ],
      raw: {
        packageOrderId: "bus-clear-1",
        manualProfitLogisticsFeeCny: 3.2,
        forcePurchaseStatus: "待拍单",
      },
    }).override;

    assert.equal(cleared.purchasePlatform, "");
    assert.equal(cleared.purchaseOrderNumber, "");
    assert.equal(cleared.purchaseOrderUrl, "");
    assert.equal(cleared.sourceCostCny, null);
    assert.equal(cleared.manualStatus, "");
    assert.deepEqual(cleared.clearFields, [
      "purchasePlatform",
      "purchaseOrderNumber",
      "purchaseOrderUrl",
      "sourceCostCny",
      "manualStatus",
    ]);
    assert.equal(cleared.packageOrderId, "bus-clear-1");
    assert.equal(cleared.manualProfitLogisticsFeeCny, 3.2);
    assert.equal(cleared.forcePurchaseStatus, "待拍单");

    const cleaned = repository.upsertOverride({
      shopId: "shop-po-clear",
      orderKey: "client-po-clear:posting-clear-1",
      postingNumber: "client-po-clear:posting-clear-1",
      raw: {
        packageOrderId: "bus-clear-1",
        manualProfitLogisticsFeeCny: 3.2,
        forcePurchaseStatus: "待拍单",
      },
    }).override;
    assert.deepEqual(cleaned.clearFields, []);
    assert.equal(cleaned.purchaseOrderNumber, "");
    assert.equal(cleaned.sourceCostCny, null);
  } finally {
    db.close();
  }
});

test("bulk legacy import applies clearFields when a multi-record fallback is replayed", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    repository.upsertOverride({
      shopId: "shop-po-bulk-clear",
      orderKey: "client-bulk:posting-clear",
      purchasePlatform: "PDD",
      purchaseOrderNumber: "purchase-before-replay",
      purchaseOrderUrl: "https://detail.example/purchase-before-replay",
      sourceCostCny: 31,
      manualStatus: "已付款",
    });

    const result = repository.importLegacyOverrides([
      {
        shopId: "shop-po-bulk-clear",
        orderKey: "client-bulk:posting-clear",
        postingNumber: "client-bulk:posting-clear",
        clearFields: [
          "purchasePlatform",
          "purchaseOrderNumber",
          "purchaseOrderUrl",
          "sourceCostCny",
          "manualStatus",
        ],
        raw: {
          clearFields: [
            "purchasePlatform",
            "purchaseOrderNumber",
            "purchaseOrderUrl",
            "sourceCostCny",
            "manualStatus",
          ],
          forcePurchaseStatus: "待拍单",
        },
      },
      {
        shopId: "shop-po-bulk-clear",
        orderKey: "client-bulk:posting-second",
        postingNumber: "client-bulk:posting-second",
        raw: { manualProfitLogisticsFeeCny: 2.5 },
      },
    ]);

    assert.equal(result.importedCount, 2);
    const cleared = repository.getOverride({
      shopId: "shop-po-bulk-clear",
      orderKey: "client-bulk:posting-clear",
    });
    assert.equal(cleared.purchasePlatform, "");
    assert.equal(cleared.purchaseOrderNumber, "");
    assert.equal(cleared.purchaseOrderUrl, "");
    assert.equal(cleared.sourceCostCny, null);
    assert.equal(cleared.manualStatus, "");
    assert.deepEqual(cleared.clearFields, [
      "purchasePlatform",
      "purchaseOrderNumber",
      "purchaseOrderUrl",
      "sourceCostCny",
      "manualStatus",
    ]);
    assert.equal(repository.listOverrides({ shopId: "shop-po-bulk-clear" }).total, 2);
  } finally {
    db.close();
  }
});

test("purchase order override repository accepts frontend manual purchase aliases", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    repository.upsertOverride({
      shopId: "shop-po-alias",
      postingNumber: "posting-alias-1",
      manualBuyerPlatform: "天猫",
      manualPurchaseOrderNo: "tmall-alias-1",
      manualPurchasePrice: "19.8",
      manualPurchaseOrderStatus: "已付款",
    });

    const page = repository.listOverrides({ shopId: "shop-po-alias" });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].purchasePlatform, "天猫");
    assert.equal(page.rows[0].purchaseOrderNumber, "tmall-alias-1");
    assert.equal(page.rows[0].sourceCostCny, 19.8);
    assert.equal(page.rows[0].manualStatus, "已付款");
  } finally {
    db.close();
  }
});

test("purchase order override repository restores cross-border fields from raw order payload", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    repository.upsertOverride({
      shopId: "shop-po-bus",
      postingNumber: "posting-bus-1",
      purchasePlatform: "PDD",
      purchaseOrderNumber: "pdd-bus-1",
      raw: {
        order: {
          packageOrderId: "49774985",
          crossBorderOrderNumber: "E362-20260624152625793387141",
          readStatus: "已读取材积",
          packageWeight: "0.07 kg",
          packageSize: "11.8 x 9.5 x 3.1 cm",
          volumeItems: [
            { length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 },
          ],
        },
      },
    });

    const page = repository.listOverrides({ shopId: "shop-po-bus" });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].packageOrderId, "49774985");
    assert.equal(
      page.rows[0].crossBorderOrderNumber,
      "E362-20260624152625793387141",
    );
    assert.equal(page.rows[0].readStatus, "已读取材积");
    assert.equal(page.rows[0].packageWeight, "0.07 kg");
    assert.equal(page.rows[0].packageSize, "11.8 x 9.5 x 3.1 cm");
    assert.deepEqual(page.rows[0].volumeItems, [
      { length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 },
    ]);
  } finally {
    db.close();
  }
});

test("purchase order override HTTP routes save list and delete without Ozon", async () => {
  const db = createMigratedTestDb();
  try {
    await withServer(db, async (base) => {
      const saveResponse = await fetch(
        `${base}/api/purchase/orders/overrides`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shopId: "shop-po2",
            postingNumber: "posting-2",
            purchasePlatform: "1688",
            purchaseOrderNumber: "1688-002",
            purchaseOrderUrl:
              "https://trade.1688.com/order/detail.htm?orderId=1688-002",
            sourceCostCny: 20,
          }),
        },
      );
      const savePayload = await saveResponse.json();
      assert.equal(saveResponse.status, 200);
      assert.equal(savePayload.ok, true);

      const listPayload = await (
        await fetch(`${base}/api/purchase/orders/overrides?shopId=shop-po2`)
      ).json();
      assert.equal(listPayload.total, 1);
      assert.equal(listPayload.rows[0].purchaseOrderNumber, "1688-002");
      assert.equal(
        listPayload.rows[0].purchaseOrderUrl,
        "https://trade.1688.com/order/detail.htm?orderId=1688-002",
      );

      const deleteResponse = await fetch(
        `${base}/api/purchase/orders/overrides`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shopId: "shop-po2", orderKey: "posting-2" }),
        },
      );
      const deletePayload = await deleteResponse.json();
      assert.equal(deletePayload.deleted, 1);
      const afterDelete = await (
        await fetch(`${base}/api/purchase/orders/overrides?shopId=shop-po2`)
      ).json();
      assert.equal(afterDelete.total, 0);
    });
  } finally {
    db.close();
  }
});

test("purchase order override HTTP list enriches dimensions from cross-border records", async () => {
  const db = createMigratedTestDb();
  try {
    const crossBorderRepository = createCrossBorderOrderRepository(db);
    crossBorderRepository.upsertRecord({
      shopId: "shop-po-bus-merge",
      orderId: "49531424",
      platform_order: "06477778-0475-1",
      readStatus: "已读取材积",
      packageWeightKg: 0.156,
      lengthCm: 16.1,
      widthCm: 11.5,
      heightCm: 4.1,
    });

    await withServer(db, async (base) => {
      const saveResponse = await fetch(
        `${base}/api/purchase/orders/overrides`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shopId: "shop-po-bus-merge",
            postingNumber: "06477778-0475-1",
            purchasePlatform: "1688",
            purchaseOrderNumber: "3309191726739621364",
            packageOrderId: "49531424",
            readStatus: "已读取材积",
            packageWeight: "0.156 kg",
            packageSize: "未返回",
          }),
        },
      );
      assert.equal(saveResponse.status, 200);

      const listPayload = await (
        await fetch(
          `${base}/api/purchase/orders/overrides?shopId=shop-po-bus-merge`,
        )
      ).json();
      assert.equal(listPayload.total, 1);
      assert.equal(listPayload.rows[0].packageOrderId, "49531424");
      assert.equal(listPayload.rows[0].packageWeight, "0.156 kg");
      assert.equal(listPayload.rows[0].packageSize, "16.1 x 11.5 x 4.1 cm");
      assert.equal(listPayload.rows[0].volumeItems[0].length, 16.1);
      assert.equal(listPayload.rows[0].volumeItems[0].width, 11.5);
      assert.equal(listPayload.rows[0].volumeItems[0].height, 4.1);
      assert.equal(
        listPayload.rows[0].volumeItems[0].sizeText,
        "16.1 x 11.5 x 4.1 cm",
      );
    });
  } finally {
    db.close();
  }
});
