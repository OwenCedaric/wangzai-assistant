import assert from 'node:assert/strict';
import test from 'node:test';

import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createProductsService } from './productsService.js';

test('product repository returns every exact Ozon SKU in the same model family', () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-sku-family');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId: 'shop-sku-family',
      rows: [
        {
          product_id: 'product-black', offer_id: 'offer-black', sku: 'ozon-black', name: 'Family product', price: '100',
          attributes: [
            { id: 9048, name: '型号', values: [{ value: 'model-family-a' }] },
            { id: 10096, name: '颜色', values: [{ value: '黑色' }] },
          ],
        },
        {
          product_id: 'product-white', offer_id: 'offer-white', sku: 'ozon-white', name: 'Family product', price: '120',
          attributes: [
            { id: 9048, name: '型号', values: [{ value: 'model-family-a' }] },
            { id: 10096, name: '颜色', values: [{ value: '白色' }] },
          ],
        },
        {
          product_id: 'product-other', offer_id: 'offer-other', sku: 'ozon-other', name: 'Other product', price: '90',
          attributes: [{ id: 9048, name: '型号', values: [{ value: 'model-family-b' }] }],
        },
      ],
    });
    const updateAttributes = db.prepare(`UPDATE ozon_products SET attributes_json = ? WHERE shop_id = ? AND sku = ?`);
    updateAttributes.run(JSON.stringify([
      { id: 9048, name: '型号', values: [{ value: 'model-family-a' }] },
      { id: 10096, name: '颜色', values: [{ value: '黑色' }] },
    ]), 'shop-sku-family', 'ozon-black');
    updateAttributes.run(JSON.stringify([
      { id: 9048, name: '型号', values: [{ value: 'model-family-a' }] },
      { id: 10096, name: '颜色', values: [{ value: '白色' }] },
    ]), 'shop-sku-family', 'ozon-white');
    updateAttributes.run(JSON.stringify([
      { id: 9048, name: '型号', values: [{ value: 'model-family-b' }] },
    ]), 'shop-sku-family', 'ozon-other');

    const result = repository.listSkuFamily({ shopId: 'shop-sku-family', sku: 'ozon-black' });
    assert.equal(result.modelIdentity, 'model-family-a');
    assert.deepEqual(result.rows.map((row) => row.sku), ['ozon-black', 'ozon-white']);
    assert.equal(result.rows[1].attributes[1].values[0].value, '白色');
    const serviceResult = createProductsService({ db }).readSkuFamily({ shopId: 'shop-sku-family', sku: 'ozon-white' });
    assert.equal(serviceResult.ok, true);
    assert.equal(serviceResult.total, 2);
  } finally {
    db.close();
  }
});
