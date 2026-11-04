import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductImageBuffer } from './productImageValidation.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');

test('validates a real PNG header, dimensions and hash', () => {
  const result = validateProductImageBuffer({ data: png, mimeType: 'image/png' });
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.sha256.length, 64);
});

test('rejects fake image bytes and MIME spoofing', () => {
  assert.throws(() => validateProductImageBuffer({ data: Buffer.from('<svg></svg>'), mimeType: 'image/png' }), /文件头/u);
  assert.throws(() => validateProductImageBuffer({ data: png, mimeType: 'image/jpeg' }), /不一致/u);
});

test('rejects dimensions above the configured pixel ceiling', () => {
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(10_000, 16);
  oversized.writeUInt32BE(10_000, 20);
  assert.throws(() => validateProductImageBuffer({ data: oversized, mimeType: 'image/png' }), /总像素/u);
});
