import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';

test('product summary source filters exact description category and type for commission lookup', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop_category_commission_filter');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [
        {
          product_id: 1001, offer_id: 'cat-10-type-20', name: '目标商品', visibility: 'IN_SALE',
          description_category_id: 10, type_id: 20,
        },
        {
          product_id: 1002, offer_id: 'cat-10-type-21', name: '其它类型', visibility: 'IN_SALE',
          description_category_id: 10, type_id: 21,
        },
        {
          product_id: 1003, offer_id: 'cat-11-type-20', name: '其它类目', visibility: 'IN_SALE',
          description_category_id: 11, type_id: 20,
        },
      ],
    });
    repository.mergeProductPriceRows({
      shopId,
      rows: [
        { product_id: 1001, offer_id: 'cat-10-type-20', price: { price: '100', currency_code: 'RUB' }, commissions: { sales_percent_rfbs: 17 } },
        { product_id: 1002, offer_id: 'cat-10-type-21', price: { price: '100', currency_code: 'RUB' }, commissions: { sales_percent_rfbs: 19 } },
        { product_id: 1003, offer_id: 'cat-11-type-20', price: { price: '100', currency_code: 'RUB' }, commissions: { sales_percent_rfbs: 21 } },
      ],
    });

    const page = repository.listProducts({
      shopId,
      descriptionCategoryId: '10',
      typeId: '20',
      pageSize: 100,
    });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].offerId, 'cat-10-type-20');
    assert.equal(page.rows[0].categoryId, '10');
    assert.equal(page.rows[0].typeId, '20');
    assert.equal(page.rows[0].commissionPercent, 17);
  } finally {
    db.close();
  }
});
