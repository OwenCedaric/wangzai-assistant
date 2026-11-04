import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { runImageProvenanceWorker } from '../src/domain/imageProvenance/imageProvenanceWorkerRunner.js';
import {
  compareWatermarkPayload,
  extractDctWatermark,
} from '../src/domain/imageProvenance/watermarkDct.js';

const output = resolve('.tmp', 'image-provenance-smoke');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

try {

// Match the current smart-tool default output instead of using a toy canvas.
const width = 1008;
const height = 1344;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    pixels[offset] = (x * 5 + y * 3 + ((x ^ y) & 63)) & 255;
    pixels[offset + 1] = (x * 2 + y * 7 + ((x * y) & 31)) & 255;
    pixels[offset + 2] = (x * 11 + y * 2 + ((x + y) & 127)) & 255;
    pixels[offset + 3] = 255;
  }
}

const originalPath = resolve(output, 'original.png');
const watermarkedPath = resolve(output, 'watermarked.png');
const psdPath = resolve(output, 'evidence.psd');
const pdfPath = resolve(output, 'evidence.pdf');
const evidencePath = resolve(output, 'evidence.json');
await writeFile(originalPath, await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
const payload = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 17 + 3) & 255));

const evidence = await runImageProvenanceWorker({
  originalPath,
  watermarkedPath,
  psdPath,
  pdfPath,
  evidencePath,
  payloadHex: payload.toString('hex'),
  assetToken: '00112233445566778899aabbccddee',
  signatureStatus: 'pending_server_claim',
  algorithmVersion: '1.0.0-shadow',
  strength: 20,
  metadata: {
    tenantId: 'smoke-tenant',
    userId: 'smoke-user',
    shopId: 'smoke-shop',
    model: 'smoke-model',
    prompt: '本地证据链烟雾测试',
    createdAt: new Date().toISOString(),
  },
}, { timeoutMs: 120_000 });

const attackedPath = resolve(output, 'attacked-jpeg85.jpg');
await sharp(watermarkedPath).jpeg({ quality: 85 }).toFile(attackedPath);
const attacked = await sharp(attackedPath)
  .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const extracted = extractDctWatermark({
  data: attacked.data,
  width: attacked.info.width,
  height: attacked.info.height,
  channels: attacked.info.channels,
});
const jpegComparison = compareWatermarkPayload(extracted.payload, payload);
const sizes = Object.fromEntries(await Promise.all([
  originalPath, watermarkedPath, psdPath, pdfPath, evidencePath, attackedPath,
].map(async (path) => [path, (await readFile(path)).byteLength])));

console.log(JSON.stringify({
  ok: evidence.watermark.localVerification.exact && jpegComparison.bitAccuracy >= 0.9,
  output,
  localVerification: evidence.watermark.localVerification,
  psnr: evidence.watermark.psnr,
  jpeg85: {
    ...jpegComparison,
    confidence: extracted.confidence,
  },
  sizes,
}, null, 2));
} finally {
  await rm(output, { recursive: true, force: true });
}
