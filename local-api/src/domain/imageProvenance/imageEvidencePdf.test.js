import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createImageEvidencePdf } from './imageEvidencePdf.js';

test('creates a self-contained one-page PDF evidence report', async () => {
  const original = await sharp({
    create: { width: 360, height: 480, channels: 4, background: '#4f76a8' },
  }).png().toBuffer();
  const watermarked = await sharp(original).modulate({ brightness: 1.002 }).png().toBuffer();
  const pdf = await createImageEvidencePdf({
    original,
    watermarked,
    metadata: {
      assetToken: '00112233445566778899aabbccddee',
      shopId: 'shop-a',
      productId: 'product-a',
      model: 'fixture-model',
      originalSha256: 'a'.repeat(64),
      watermarkedSha256: 'b'.repeat(64),
      psdSha256: 'c'.repeat(64),
      watermarkVerification: { exact: true, confidence: 1 },
      psnr: 49.25,
    },
  });
  assert.ok(pdf.byteLength > 20_000);
  assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.match(pdf.subarray(-64).toString('ascii'), /%%EOF/u);
  assert.match(pdf.toString('latin1'), /\/Subtype \/Image/u);
});
