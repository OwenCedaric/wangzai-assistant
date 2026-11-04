import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app/createApp.js";
import { createCrossBorderOrderRepository } from "../src/db/repositories/crossBorderOrderRepository.js";
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
        throw new Error("cross-border order tests must not call Ozon");
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

test("cross-border order repository stores bus identifiers and volume fields in SQLite", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderOrderRepository(db);
    const saved = repository.upsertRecord({
      shopId: "shop-cb1",
      order_id: "bus-001",
      platform_order: "posting-001-1",
      from_order: "purchase-001",
      status: "已预报",
      volumeItems: [{ weight: "1.25kg", length: 10, width: 20, height: 30 }],
    });
    assert.equal(saved.ok, true);
    const page = repository.listRecords({
      shopId: "shop-cb1",
      keyword: "posting-001",
    });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].orderId, "bus-001");
    assert.equal(page.rows[0].platformOrder, "posting-001-1");
    assert.equal(page.rows[0].purchaseOrderNumber, "purchase-001");
    assert.equal(page.rows[0].packageWeightKg, 1.25);
    assert.deepEqual(page.rows[0].volumeItems, [
      { weight: "1.25kg", length: 10, width: 20, height: 30 },
    ]);
  } finally {
    db.close();
  }
});

test("cross-border order repository does not overwrite existing valid fields with empty retry data", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderOrderRepository(db);
    repository.upsertRecord({
      shopId: "shop-cb2",
      order_id: "bus-002",
      platform_order: "posting-002-1",
      status: "已读取材积",
      packageWeightKg: 2.5,
      lengthCm: 11,
    });
    repository.upsertRecord({
      shopId: "shop-cb2",
      order_id: "bus-002",
      platform_order: "",
      status: "",
      packageWeightKg: "",
      widthCm: 22,
    });
    const record = repository.listRecords({
      shopId: "shop-cb2",
      orderId: "bus-002",
    }).rows[0];
    assert.equal(record.status, "已读取材积");
    assert.equal(record.platformOrder, "posting-002-1");
    assert.equal(record.packageWeightKg, 2.5);
    assert.equal(record.lengthCm, 11);
    assert.equal(record.widthCm, 22);
  } finally {
    db.close();
  }
});

test("cross-border order repository derives dimensions from bus outInfo volume payload", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderOrderRepository(db);
    repository.upsertRecord({
      orderId: "bus-out-info-001",
      outPayload: {
        weight: "0.152",
        grossweight: "0.167",
        volume: [
          {
            length: "15.3",
            width: "13.2",
            height: "4.1",
            gross_weight: "0.167",
          },
        ],
      },
    });

    const record = repository.listRecords({
      orderId: "bus-out-info-001",
    }).rows[0];

    assert.equal(record.packageWeightKg, 0.152);
    assert.equal(record.lengthCm, 15.3);
    assert.equal(record.widthCm, 13.2);
    assert.equal(record.heightCm, 4.1);
    assert.deepEqual(record.volumeItems, [
      {
        length: "15.3",
        width: "13.2",
        height: "4.1",
        gross_weight: "0.167",
      },
    ]);
  } finally {
    db.close();
  }
});

test("cross-border order repository extracts posting and purchase ids from bus list payload", () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderOrderRepository(db);
    repository.upsertRecord({
      shopId: "shop-cb-list",
      id: "49774985",
      platform_order: "E362-20260624152625793387141",
      storehouse_name: "2311济南七号仓",
      introduce: "标准-超级轻小件-陆空联运到配送点 PUDO",
      sheet_info: {
        sheet_order_sn: "0123640791-0163-1",
        section_order: "0123640791-0163-1",
      },
      package_list: [
        {
          logistics_order: "JT5499205452623",
          from_order: "260624-284667440772967",
        },
      ],
    });

    const byPosting = repository.listRecords({
      shopId: "shop-cb-list",
      keyword: "0123640791-0163-1",
    });
    assert.equal(byPosting.total, 1);
    assert.equal(byPosting.rows[0].orderId, "49774985");
    assert.equal(byPosting.rows[0].sheetOrderNumber, "0123640791-0163-1");
    assert.equal(
      byPosting.rows[0].purchaseOrderNumber,
      "260624-284667440772967",
    );
    assert.equal(byPosting.rows[0].logisticsOrder, "JT5499205452623");
    assert.equal(byPosting.rows[0].warehouse, "2311济南七号仓");
    assert.equal(
      byPosting.rows[0].routeName,
      "标准-超级轻小件-陆空联运到配送点 PUDO",
    );
  } finally {
    db.close();
  }
});

test("cross-border order HTTP routes save list and delete without remote calls", async () => {
  const db = createMigratedTestDb();
  try {
    await withServer(db, async (base) => {
      const saveResponse = await fetch(
        `${base}/api/logistics/cross-border/orders`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shopId: "shop-cb3",
            orderId: "bus-003",
            orderNumber: "posting-003-1",
            trackingNumber: "track-003",
            readStatus: "巴士已回查",
          }),
        },
      );
      const savePayload = await saveResponse.json();
      assert.equal(saveResponse.status, 200);
      assert.equal(savePayload.ok, true);

      const listPayload = await (
        await fetch(
          `${base}/api/logistics/cross-border/orders?shopId=shop-cb3&keyword=track-003`,
        )
      ).json();
      assert.equal(listPayload.total, 1);
      assert.equal(listPayload.rows[0].trackingNumber, "track-003");
      assert.equal(listPayload.rows[0].readStatus, "巴士已回查");

      const deleteResponse = await fetch(
        `${base}/api/logistics/cross-border/orders`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shopId: "shop-cb3", orderId: "bus-003" }),
        },
      );
      const deletePayload = await deleteResponse.json();
      assert.equal(deletePayload.deleted, 1);
      const afterDelete = await (
        await fetch(`${base}/api/logistics/cross-border/orders?shopId=shop-cb3`)
      ).json();
      assert.equal(afterDelete.total, 0);
    });
  } finally {
    db.close();
  }
});
