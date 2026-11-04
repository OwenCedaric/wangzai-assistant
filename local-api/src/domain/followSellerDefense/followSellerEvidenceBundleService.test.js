import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createImageProvenanceFileRepository } from '../imageProvenance/imageProvenanceFileRepository.js';
import { processImageProvenanceEvidence } from '../imageProvenance/imageProvenanceWorker.js';
import { createFollowSellerEvidenceBundleService } from './followSellerEvidenceBundleService.js';

const scope = Object.freeze({ tenantId: 'tenant-a', userId: 'user-a', shopId: 'shop-a' });

function caseRecord(overrides = {}) {
  return {
    id: 'case-a',
    shopId: 'shop-a',
    sku: '900000001',
    offerId: 'OFFER-A',
    productId: 'PRODUCT-A',
    productName: 'Тестовый товар',
    followSellerCount: 2,
    sellers: [
      {
        sku: '3771432837',
        sellerId: '4127044',
        sellerName: 'seller-one',
        productLink: 'https://www.ozon.ru/product/follower-one-3771432837/',
        price: 2841,
      },
      {
        sku: '3771432838',
        sellerId: '4127045',
        sellerName: 'seller-two',
        productLink: 'https://www.ozon.ru/product/follower-two-3771432838/',
        price: 2810,
      },
    ],
    ...overrides,
  };
}

async function createCompletedProvenanceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-follow-seller-evidence-'));
  const provenanceRoot = join(root, 'provenance');
  const bundleRoot = join(root, 'bundles');
  const repository = createImageProvenanceFileRepository({ root: provenanceRoot });
  const assetToken = '00112233445566778899aabbccddee';
  const payloadHex = '10'.repeat(32);
  const sourceAssetId = 'pimg-source-a';
  let job = await repository.createOrGet({
    shopId: scope.shopId,
    sourceAssetId,
    sourceType: 'unit-test',
    assetToken,
    algorithmVersion: '1.1.0-upload',
    rightsOwner: 'Wangzai Rights Owner',
    generation: {
      productId: 'PRODUCT-A',
      offerId: 'OFFER-A',
      model: 'fixture-model',
      prompt: 'fixture prompt',
      generationMode: 'standard',
    },
  }, scope);
  const evidenceDirectory = repository.evidenceDirectory(assetToken, scope);
  await mkdir(evidenceDirectory, { recursive: true });
  const originalPath = join(evidenceDirectory, 'original.png');
  const watermarkedPath = join(evidenceDirectory, 'watermarked.png');
  const psdPath = join(evidenceDirectory, 'evidence.psd');
  const pdfPath = join(evidenceDirectory, 'evidence.pdf');
  const evidencePath = join(evidenceDirectory, 'evidence.json');
  const width = 512;
  const height = 512;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    const pixel = index / 4;
    rgba[index] = (pixel * 3) & 255;
    rgba[index + 1] = (pixel * 7) & 255;
    rgba[index + 2] = (pixel * 13) & 255;
    rgba[index + 3] = 255;
  }
  const original = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await writeFile(originalPath, original);
  job = await repository.updateJob(job.id, scope, { payloadHex, assetToken, status: 'processing' });
  const result = await processImageProvenanceEvidence({
    originalPath,
    watermarkedPath,
    psdPath,
    pdfPath,
    evidencePath,
    payloadHex,
    assetToken,
    signatureStatus: 'pending_server_claim',
    mode: 'upload-enforced',
    algorithmVersion: job.algorithmVersion,
    strength: 20,
    metadata: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      shopId: scope.shopId,
      rightsOwner: 'Wangzai Rights Owner',
      sourceAssetId,
      sourceType: 'unit-test',
      mimeType: 'image/png',
      productId: 'PRODUCT-A',
      offerId: 'OFFER-A',
      generationJobId: 'generation-a',
      model: 'fixture-model',
      prompt: 'fixture prompt',
      generationMode: 'standard',
      createdAt: '2026-08-15T00:00:00.000Z',
    },
  });
  job = await repository.updateJob(job.id, scope, {
    status: 'completed',
    stage: 'protected_asset_ready',
    completedAt: '2026-08-15T00:01:00.000Z',
    result: {
      trustLevel: result.trustLevel,
      claimStatus: result.claimStatus,
      hashes: result.hashes,
      watermark: result.watermark,
      files: result.files,
      publicationAsset: { id: 'pimg-watermarked-a' },
      uploadPolicy: 'watermarked-only',
    },
  });
  const service = createFollowSellerEvidenceBundleService({
    provenanceRepository: repository,
    root: bundleRoot,
    now: () => new Date('2026-08-15T01:02:03.000Z'),
  });
  return { root, bundleRoot, repository, service, job, psdPath };
}

async function createBrowserCapture(bundle, record = caseRecord()) {
  const directory = bundle.materialDirectory;
  const png = await sharp({
    create: { width: 960, height: 720, channels: 4, background: '#dbeafe' },
  }).png().toBuffer();
  const descriptor = async (name) => {
    const path = join(directory, name);
    await writeFile(path, png);
    return {
      name,
      path,
      sha256: createHash('sha256').update(png).digest('hex'),
      size: png.byteLength,
    };
  };
  const ownProductPage = await descriptor('own-product-page.png');
  const ownSellerList = await descriptor('own-seller-list.png');
  const followerProductPages = [];
  for (let index = 0; index < record.sellers.length; index += 1) {
    const seller = record.sellers[index];
    followerProductPages.push({
      ...(await descriptor(`follower-${String(index + 1).padStart(2, '0')}-${seller.sku}-page.png`)),
      sku: seller.sku,
      productLink: seller.productLink,
    });
  }
  const ledgerValue = {
    schemaVersion: 1,
    workflow: 'ozon-scheme2-browser-evidence-v1',
    evidenceId: bundle.evidenceId,
    originalSku: record.sku,
    offerId: record.offerId,
    capturedAt: '2026-08-16T01:02:03.000Z',
    listingDate: '2026-08-01',
    ownProductPage,
    ownSellerList,
    followerProductPages,
  };
  const ledgerPath = join(directory, 'scheme2-evidence-capture.json');
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledgerValue, null, 2)}\n`, 'utf8');
  await writeFile(ledgerPath, ledgerBytes);
  return {
    ...ledgerValue,
    ledger: {
      name: 'scheme2-evidence-capture.json',
      path: ledgerPath,
      sha256: createHash('sha256').update(ledgerBytes).digest('hex'),
      size: ledgerBytes.byteLength,
    },
  };
}

test('prepares and validates exactly PSD + multi-page PDF with Russian speech and a local manifest', {
  timeout: 70_000,
}, async () => {
  const fixture = await createCompletedProvenanceFixture();
  // Production patrol cases only know the Ozon product/offer.  The service
  // must locate the latest completed watermarked provenance job itself.
  const record = caseRecord();
  const bundle = await fixture.service.prepare({ caseRecord: record }, scope);

  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.revision, 1);
  assert.equal(bundle.reuse.mode, 'created');
  assert.equal(bundle.browserEvidenceReady, false);
  assert.equal(bundle.files.length, 2);
  assert.deepEqual(bundle.files.map((file) => file.kind), ['psd', 'pdf']);
  assert.deepEqual(bundle.files.map((file) => file.mimeType), [
    'image/vnd.adobe.photoshop',
    'application/pdf',
  ]);
  assert.match(bundle.speech, /Прошу провести проверку/u);
  assert.match(bundle.speech, /3771432837/u);
  assert.match(bundle.speech, /3771432838/u);
  assert.ok(!bundle.files.some((file) => /\.(?:zip|json)$/iu.test(file.name)));

  const psd = await readFile(bundle.files[0].path);
  const pdf = await readFile(bundle.files[1].path);
  assert.equal(psd.subarray(0, 4).toString('ascii'), '8BPS');
  assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/gu) || []).length >= 4);

  const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.revision, 1);
  assert.equal(manifest.evidenceIndex.totalPages >= 4, true);
  assert.deepEqual(manifest.evidenceIndex.sections.map((section) => section.key), [
    'case-summary',
    'seller-inventory',
    'image-comparison',
    'technical-verification',
    'ozon-statement',
  ]);
  assert.equal(manifest.uploadContract.archive, false);
  assert.equal(manifest.uploadContract.attachmentCount, 2);
  assert.deepEqual(manifest.uploadContract.requiredKinds, ['psd', 'pdf']);
  assert.equal(manifest.sourceProvenance[0].watermark.exact, true);
  assert.equal(manifest.sourceProvenance[0].watermark.matchingBits, 256);
  assert.equal(manifest.attachments.length, 2);

  const validated = await fixture.service.validate(bundle, { caseRecord: record }, scope);
  assert.equal(validated.status, 'ready');
  assert.deepEqual(validated.hashes, bundle.hashes);

  const corruptedPdf = Buffer.from(pdf);
  corruptedPdf[Math.floor(corruptedPdf.length / 2)] ^= 0x01;
  await writeFile(bundle.files[1].path, corruptedPdf);
  await assert.rejects(
    fixture.service.validate(bundle, { caseRecord: record }, scope),
    (error) => error?.code === 'FOLLOW_SELLER_EVIDENCE_HASH_MISMATCH',
  );
});

test('assembles Ozon product screenshots into PDF and keeps seller list as later-only supplement', {
  timeout: 70_000,
}, async () => {
  const fixture = await createCompletedProvenanceFixture();
  const record = caseRecord();
  const prepared = await fixture.service.prepare({ caseRecord: record }, scope);
  const initialPdf = prepared.files.find((file) => file.kind === 'pdf');
  const initialPageCount = ((await readFile(initialPdf.path)).toString('latin1').match(/\/Type \/Page\b/gu) || []).length;
  const capture = await createBrowserCapture(prepared, record);

  const assembled = await fixture.service.finalizeBrowserEvidence(
    prepared,
    { caseRecord: record, capture },
    scope,
  );
  assert.equal(assembled.browserEvidenceReady, true);
  assert.equal(assembled.browserEvidence.listingDate, '2026-08-01');
  assert.equal(assembled.browserEvidence.followerProductPages.length, 2);
  assert.equal(assembled.files.length, 2);
  assert.deepEqual(assembled.files.map((file) => file.kind), ['psd', 'pdf']);
  assert.notEqual(assembled.hashes.pdfSha256, initialPdf.sha256);

  const manifest = JSON.parse(await readFile(assembled.manifestPath, 'utf8'));
  const sectionKeys = manifest.evidenceIndex.sections.map((section) => section.key);
  assert.ok(sectionKeys.includes('ozon-own-product-page'));
  assert.ok(sectionKeys.includes('ozon-follower-pages'));
  assert.ok(!sectionKeys.includes('ozon-seller-list'));
  assert.equal(manifest.browserEvidence.ownSellerList.name, 'own-seller-list.png');
  const assembledPdf = assembled.files.find((file) => file.kind === 'pdf');
  const assembledPageCount = ((await readFile(assembledPdf.path)).toString('latin1').match(/\/Type \/Page\b/gu) || []).length;
  assert.ok(assembledPageCount >= initialPageCount + 3);

  const reused = await fixture.service.prepare({
    caseRecord: { ...record, id: 'case-a-rescan-after-assembly' },
  }, scope);
  assert.equal(reused.reuse.mode, 'reused');
  assert.equal(reused.browserEvidenceReady, true);
  assert.equal(reused.hashes.pdfSha256, assembled.hashes.pdfSha256);

  const tamperedCapture = {
    ...capture,
    followerProductPages: capture.followerProductPages.map((file, index) => (
      index === 0 ? { ...file, productLink: 'https://www.ozon.ru/product/wrong-3771432837/' } : file
    )),
  };
  await assert.rejects(
    fixture.service.finalizeBrowserEvidence(reused, { caseRecord: record, capture: tamperedCapture }, scope),
    (error) => error?.code === 'FOLLOW_SELLER_SCHEME2_FOLLOWER_CAPTURE_MISMATCH',
  );
});

test('reuses one product evidence pair and only revisions it when the seller evidence changes', {
  timeout: 70_000,
}, async () => {
  const fixture = await createCompletedProvenanceFixture();
  const firstRecord = caseRecord();
  const first = await fixture.service.prepare({ caseRecord: firstRecord }, scope);
  const reused = await fixture.service.prepare({
    caseRecord: { ...firstRecord, id: 'case-a-second-scan' },
  }, scope);

  assert.equal(reused.evidenceId, first.evidenceId);
  assert.deepEqual(reused.files.map((file) => file.path), first.files.map((file) => file.path));
  assert.equal(reused.revision, 1);
  assert.equal(reused.reuse.mode, 'reused');
  assert.deepEqual(reused.hashes, first.hashes);

  const changedRecord = caseRecord({
    id: 'case-a-third-scan',
    followSellerCount: 3,
    sellers: [
      ...firstRecord.sellers,
      {
        sku: '3771432839',
        sellerId: '4127046',
        sellerName: 'seller-three',
        productLink: 'https://www.ozon.ru/product/follower-three-3771432839/',
        price: 2799,
      },
    ],
  });
  const updated = await fixture.service.prepare({ caseRecord: changedRecord }, scope);
  assert.equal(updated.evidenceId, first.evidenceId);
  assert.deepEqual(updated.files.map((file) => file.path), first.files.map((file) => file.path));
  assert.equal(updated.revision, 2);
  assert.equal(updated.reuse.mode, 'updated');

  const manifest = JSON.parse(await readFile(updated.manifestPath, 'utf8'));
  assert.equal(manifest.revisionHistory.length, 2);
  assert.deepEqual(manifest.changeSummary.addedFollowerSkus, ['3771432839']);
  assert.deepEqual(manifest.changeSummary.removedFollowerSkus, []);
  assert.equal(manifest.parentRevision.revision, 1);
  assert.equal(manifest.parentRevision.bundleSha256, first.hashes.bundleSha256);
  assert.deepEqual(manifest.case.sellers.map((seller) => seller.sku), [
    '3771432837',
    '3771432838',
    '3771432839',
  ]);

  const validated = await fixture.service.validate(updated, { caseRecord: changedRecord }, scope);
  assert.equal(validated.revision, 2);
});

test('fails closed when a completed provenance source PSD no longer matches its SHA-256', {
  timeout: 70_000,
}, async () => {
  const fixture = await createCompletedProvenanceFixture();
  const originalPsd = await readFile(fixture.psdPath);
  const changed = Buffer.from(originalPsd);
  changed[changed.length - 1] ^= 0x01;
  await writeFile(fixture.psdPath, changed);
  await assert.rejects(
    fixture.service.prepare({
      caseRecord: caseRecord({ provenanceJobIds: [fixture.job.id] }),
    }, scope),
    (error) => error?.code === 'FOLLOW_SELLER_EVIDENCE_HASH_MISMATCH',
  );
});

test('does not hide tampering by regenerating over a corrupted reusable bundle', {
  timeout: 70_000,
}, async () => {
  const fixture = await createCompletedProvenanceFixture();
  const record = caseRecord();
  const bundle = await fixture.service.prepare({ caseRecord: record }, scope);
  const pdfPath = bundle.files.find((file) => file.kind === 'pdf').path;
  const corrupted = Buffer.from(await readFile(pdfPath));
  corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
  await writeFile(pdfPath, corrupted);

  await assert.rejects(
    fixture.service.prepare({ caseRecord: record }, scope),
    (error) => error?.code === 'FOLLOW_SELLER_EVIDENCE_HASH_MISMATCH',
  );
  assert.deepEqual(await readFile(pdfPath), corrupted);
});

test('fails before generating evidence when patrol count exceeds complete seller details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wangzai-follow-seller-count-'));
  const repository = {
    root,
    evidenceRoot: root,
    async getJob() { return null; },
  };
  const service = createFollowSellerEvidenceBundleService({ provenanceRepository: repository, root: join(root, 'bundle') });
  await assert.rejects(
    service.prepare({
      caseRecord: caseRecord({ followSellerCount: 70, provenanceJobId: 'ipj-a' }),
    }, scope),
    (error) => error?.code === 'FOLLOW_SELLER_EVIDENCE_SELLER_COUNT_MISMATCH',
  );
});
