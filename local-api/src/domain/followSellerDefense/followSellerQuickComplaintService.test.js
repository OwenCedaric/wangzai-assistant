import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFollowSellerQuickComplaintService } from './followSellerQuickComplaintService.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function caseRecord(overrides = {}) {
  return {
    id: 'case-1',
    shopId: 'shop-1',
    productId: 'product-1',
    offerId: 'offer-1',
    sku: '900000001',
    followCountBefore: 1,
    sellers: [{
      sku: '3771432837',
      sellerId: 'seller-7',
      sellerName: 'seller name',
      productLink: 'https://www.ozon.ru/product/3771432837/',
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
      observedAt: '2026-08-15T01:02:03.000Z',
      sourceDigest: 'a'.repeat(64),
    }],
    ...overrides,
  };
}

test('scheme1 prepares exact current images, bilingual wording and a tamper-checked local manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const repository = {
      getProductComplaintMaterial() {
        return {
          shopId: 'shop-1',
          productId: 'product-1',
          offerId: 'offer-1',
          sku: '900000001',
          imageUrls: ['https://cdn.example.test/current.png'],
        };
      },
    };
    const service = createFollowSellerQuickComplaintService({
      repository,
      root,
      fetchImpl: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    });
    const prepared = await service.prepare({ caseRecord: caseRecord() });
    assert.equal(prepared.scheme, 'scheme1-seller-backend');
    assert.equal(prepared.files.length, 1);
    assert.equal(prepared.files[0].mimeType, 'image/png');
    assert.match(prepared.speech.initialEvidenceRu, /Вложение 1 — наша карточка/u);
    assert.match(prepared.speech.initialEvidenceRu, /Вложение 2 — наше фото/u);
    assert.match(prepared.speech.initialEvidenceRu, /Вложение 3 — карточка продавца, SKU 3771432837/u);
    assert.match(prepared.speech.supplementRu, /списка товаров из нашего кабинета продавца/u);
	    assert.match(prepared.speech.supplementRu, /\{\{LISTING_DATE\}\}/u);
    assert.match(prepared.speech.followerBatchRu, /^3771432837\n/u);
    assert.ok(prepared.speech.initialEvidenceRu.length <= 1000);
    assert.ok(prepared.speech.supplementRu.length <= 1000);
    assert.ok(prepared.speech.followerBatchRu.length <= 1000);
	    assert.match(prepared.speech.zh, /跟卖 SKU 3771432837/u);
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
	    assert.equal(manifest.version, 2);
	    assert.equal(manifest.workflow, 'ozon-seller-backend-content-complaint-v2');
    assert.equal(manifest.shopId, 'shop-1');
    assert.equal(manifest.originalSku, '900000001');
	    assert.deepEqual(manifest.evidenceFollowers.map((item) => item.sku), ['3771432837']);
	assert.deepEqual(prepared.followers, manifest.followers);
    await service.validate(prepared, { caseRecord: caseRecord() });
    await writeFile(prepared.files[0].path, Buffer.concat([PNG, Buffer.from([9])]));
    await assert.rejects(
      service.validate(prepared, { caseRecord: caseRecord() }),
      (error) => error.code === 'FOLLOW_SELLER_SCHEME1_FILE_TAMPERED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheme1 keeps every follower SKU under one product evidence bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const sellers = ['3771432837', '3771432838', '3771432839'].map((sku) => ({
      sku,
      sellerId: `seller-${sku}`,
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
    }));
    const service = createFollowSellerQuickComplaintService({
      repository: {
        getProductComplaintMaterial: () => ({
          shopId: 'shop-1',
          productId: 'product-1',
          offerId: 'offer-1',
          sku: '900000001',
          imageUrls: ['https://cdn.example.test/current.png'],
        }),
      },
      root,
      fetchImpl: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    });
    const prepared = await service.prepare({
      caseRecord: caseRecord({ followCountBefore: sellers.length, sellers }),
    });
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
    assert.equal(prepared.followerCount, 3);
    assert.deepEqual(manifest.followers.map((item) => item.sku), sellers.map((item) => item.sku));
	assert.deepEqual(prepared.followers.map((item) => item.sku), sellers.map((item) => item.sku));
	for (const follower of prepared.followers) assert.match(follower.productLink, new RegExp(follower.sku, 'u'));
	    assert.deepEqual(prepared.evidenceFollowers.map((item) => item.sku), sellers.map((item) => item.sku));
	    assert.match(prepared.speech.followerBatchRu, /^3771432837\n3771432838\n3771432839\n/u);
    for (const seller of sellers) assert.match(prepared.speech.zh, new RegExp(seller.sku, 'u'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheme1 refuses a patrol count that is larger than the exact follower SKU list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const service = createFollowSellerQuickComplaintService({
      repository: { getProductComplaintMaterial: () => null },
      root,
      fetchImpl: async () => new Response(PNG),
    });
    await assert.rejects(
      service.prepare({ caseRecord: caseRecord({ followCountBefore: 2 }) }),
      (error) => error.code === 'FOLLOW_SELLER_SCHEME1_FOLLOWER_DATA_INCOMPLETE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheme1 caps visual evidence at three own images and three follower pages but keeps every follower SKU in one final message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const sellers = ['3771432837', '3771432838', '3771432839', '3771432840'].map((sku) => ({
      sku,
      productLink: `https://www.ozon.ru/product/${sku}/`,
      sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
    }));
    const service = createFollowSellerQuickComplaintService({
      repository: {
        getProductComplaintMaterial: () => ({
          shopId: 'shop-1',
          productId: 'product-1',
          offerId: 'offer-1',
          sku: '900000001',
          imageUrls: [1, 2, 3, 4].map((index) => `https://cdn.example.test/current-${index}.png`),
        }),
      },
      root,
      fetchImpl: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    });
    const prepared = await service.prepare({
      caseRecord: caseRecord({ followCountBefore: sellers.length, sellers }),
    });
    assert.equal(prepared.files.length, 3);
    assert.equal(prepared.evidenceFollowers.length, 3);
    assert.match(prepared.speech.initialEvidenceRu, /Вложение 7 — карточка продавца/u);
    assert.doesNotMatch(prepared.speech.initialEvidenceRu, /Вложение 8/u);
    for (const seller of sellers) assert.match(prepared.speech.followerBatchRu, new RegExp(seller.sku, 'u'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheme1 compacts long Ozon slugs into one complete seven-attachment message under 1000 characters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const originalSku = '5268230022';
    const sellers = [
      ['5470333931', 'eksklyuzivnaya-vstavka-premiumklassa-pod-teksturu-dereva-dlya-bloka-ruchnogo-upravleniya'],
      ['5445458406', 'dlinnaya-kartochka-tovara-drugogo-prodavtsa-s-povtoryayushchimisya-slovami-i-opisaniem'],
      ['5479844689', 'eshche-odna-ochen-dlinnaya-kartochka-tovara-s-polnym-nazvaniem-i-harakteristikami'],
    ].map(([sku, slug]) => ({
      sku,
      productLink: `https://www.ozon.ru/product/${slug}-${sku}/`,
      sourceProductUrl: `https://www.ozon.ru/product/nasha-dlinnaya-kartochka-${originalSku}/`,
    }));
    const imageUrls = [
      'https://ir.ozone.ru/s3/multimedia-1-k/13192456052.jpg',
      'https://ir.ozone.ru/s3/multimedia-1-5/13192455209.jpg',
      'https://ir.ozone.ru/s3/multimedia-1-a/13192455210.jpg',
    ];
    const service = createFollowSellerQuickComplaintService({
      repository: {
        getProductComplaintMaterial: () => ({
          shopId: 'ozon-shop-example-02',
          productId: '5724575685',
          offerId: 'SKU-202607300445-01-10',
          sku: originalSku,
          imageUrls,
        }),
      },
      root,
      fetchImpl: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    });
    const prepared = await service.prepare({
      caseRecord: caseRecord({
        shopId: 'ozon-shop-example-02',
        productId: '5724575685',
        offerId: 'SKU-202607300445-01-10',
        sku: originalSku,
        followCountBefore: sellers.length,
        sellers,
      }),
    });

    assert.equal(prepared.files.length, 3);
    assert.equal(prepared.evidenceFollowers.length, 3);
    assert.ok(prepared.speech.initialEvidenceRu.length <= 1000);
    for (let attachment = 1; attachment <= 7; attachment += 1) {
      assert.match(prepared.speech.initialEvidenceRu, new RegExp(`Вложение ${attachment}\\b`, 'u'));
    }
    for (const imageUrl of imageUrls) assert.match(prepared.speech.initialEvidenceRu, new RegExp(imageUrl, 'u'));
    for (const [sku, slug] of sellers.map((item) => [item.sku, item.productLink.split('/product/')[1].split(`-${item.sku}`)[0]])) {
      assert.match(prepared.speech.initialEvidenceRu, new RegExp(`https://www\\.ozon\\.ru/product/${sku}/`, 'u'));
      assert.doesNotMatch(prepared.speech.initialEvidenceRu, new RegExp(slug, 'u'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheme1 rejects a follower page whose URL does not contain the matching SKU', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'follow-seller-evidence-'));
  try {
    const service = createFollowSellerQuickComplaintService({
      repository: {
        getProductComplaintMaterial: () => ({
          shopId: 'shop-1',
          productId: 'product-1',
          offerId: 'offer-1',
          sku: '900000001',
          imageUrls: ['https://cdn.example.test/current.png'],
        }),
      },
      root,
      fetchImpl: async () => new Response(PNG),
    });
    await assert.rejects(
      service.prepare({
        caseRecord: caseRecord({
          sellers: [{
            sku: '3771432837',
            productLink: 'https://www.ozon.ru/product/9999999999/',
            sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
          }],
        }),
      }),
      (error) => error.code === 'FOLLOW_SELLER_SCHEME1_FOLLOWER_URL_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
