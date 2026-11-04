import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareWatermarkPayload,
  embedDctWatermark,
  extractDctWatermark,
  imageWatermarkContract,
} from './watermarkDct.js';

function fixture(width = 512, height = 512) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 3 + y * 5 + ((x ^ y) & 31)) & 255;
      data[offset + 1] = (x * 7 + y * 2 + ((x * y) & 15)) & 255;
      data[offset + 2] = (x * 2 + y * 11 + ((x + y) & 63)) & 255;
      data[offset + 3] = 255;
    }
  }
  return { width, height, channels: 4, data };
}

test('embeds and blindly extracts the complete 256-bit payload', () => {
  const payload = Buffer.from(Array.from({ length: imageWatermarkContract.payloadBytes }, (_, index) => index));
  const embedded = embedDctWatermark(fixture(), payload, { strength: 20 });
  const extracted = extractDctWatermark(embedded);
  const comparison = compareWatermarkPayload(extracted.payload, payload);
  assert.equal(comparison.exact, true);
  assert.equal(comparison.bitAccuracy, 1);
  assert.ok(embedded.stats.repetitionsPerBit >= 16);
  assert.ok(extracted.confidence > 0.2);
});

test('does not mutate the original RGBA buffer', () => {
  const original = fixture(256, 256);
  const before = Buffer.from(original.data);
  embedDctWatermark(original, Buffer.alloc(32, 0xa5));
  assert.deepEqual(original.data, before);
});
