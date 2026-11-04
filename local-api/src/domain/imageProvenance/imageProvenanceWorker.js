import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { createEvidencePsd } from './imageEvidencePsd.js';
import { createImageEvidencePdf } from './imageEvidencePdf.js';
import {
  compareWatermarkPayload,
  embedDctWatermark,
  extractDctWatermark,
} from './watermarkDct.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function calculatePsnr(original, changed) {
  let error = 0;
  let samples = 0;
  for (let index = 0; index < original.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = original[index + channel] - changed[index + channel];
      error += difference * difference;
      samples += 1;
    }
  }
  const mse = samples ? error / samples : 0;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

async function decodeRgba(path, resize = null) {
  let pipeline = sharp(path, { limitInputPixels: 40_000_000 }).rotate();
  if (resize?.width && resize?.height) {
    pipeline = pipeline.resize(resize.width, resize.height, { fit: 'fill', kernel: 'lanczos3' });
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

export async function processImageProvenanceEvidence(input = {}) {
  const original = await decodeRgba(input.originalPath);
  const payload = Buffer.from(String(input.payloadHex || ''), 'hex');
  const embedded = embedDctWatermark(original, payload, {
    strength: input.strength,
  });
  const watermarkedPng = await sharp(embedded.data, {
    raw: {
      width: embedded.width,
      height: embedded.height,
      channels: embedded.channels,
    },
  }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  await writeFile(input.watermarkedPath, watermarkedPng);

  const storedWatermarked = await decodeRgba(input.watermarkedPath, {
    width: original.width,
    height: original.height,
  });
  const extracted = extractDctWatermark(storedWatermarked);
  const comparison = compareWatermarkPayload(extracted.payload, payload);
  const originalBytes = await readFile(input.originalPath);
  const originalSha256 = sha256(originalBytes);
  const watermarkedSha256 = sha256(watermarkedPng);
  const psnr = calculatePsnr(original.data, storedWatermarked.data);
  const metadata = {
    ...(input.metadata || {}),
    assetToken: input.assetToken,
    originalSha256,
    watermarkedSha256,
    signatureStatus: input.signatureStatus || 'pending_server_claim',
  };
  const psd = await createEvidencePsd({
    originalRgba: original.data,
    watermarkedRgba: storedWatermarked.data,
    width: original.width,
    height: original.height,
    metadata,
  });
  await writeFile(input.psdPath, psd);
  const psdSha256 = sha256(psd);
  const pdf = await createImageEvidencePdf({
    original: originalBytes,
    watermarked: watermarkedPng,
    metadata: {
      ...metadata,
      watermarkedSha256,
      psdSha256,
      generationMode: input.metadata?.generationMode || 'standard',
        watermarkVerification: {
          ...comparison,
          confidence: extracted.confidence,
          minimumBitConfidence: extracted.minimumBitConfidence,
        },
      psnr,
    },
  });
  await writeFile(input.pdfPath, pdf);
  const pdfSha256 = sha256(pdf);

  const evidence = {
    schemaVersion: 1,
    mode: input.mode || 'shadow',
    trustLevel: 'local-shadow-only',
    claimStatus: input.signatureStatus || 'pending_server_claim',
    algorithm: embedded.stats.algorithm,
    algorithmVersion: input.algorithmVersion || '1.1.0-upload',
    workerVersion: '1.0.0',
    assetToken: input.assetToken,
    payloadHex: input.payloadHex,
    owner: {
      tenantId: input.metadata?.tenantId || '',
      userId: input.metadata?.userId || '',
      rightsOwner: input.metadata?.rightsOwner || input.metadata?.userId || '',
    },
    generation: {
      jobId: input.metadata?.generationJobId || '',
      model: input.metadata?.model || '',
      accountId: input.metadata?.accountId || '',
      generationMode: input.metadata?.generationMode || 'standard',
      prompt: input.metadata?.prompt || '',
      promptSha256: sha256(Buffer.from(input.metadata?.prompt || '', 'utf8')),
      createdAt: input.metadata?.createdAt || new Date().toISOString(),
    },
    source: {
      shopId: input.metadata?.shopId || '',
      productId: input.metadata?.productId || '',
      offerId: input.metadata?.offerId || '',
      sourceAssetId: input.metadata?.sourceAssetId || '',
      sourceType: input.metadata?.sourceType || '',
      mimeType: input.metadata?.mimeType || '',
      width: original.width,
      height: original.height,
    },
    hashes: {
      originalSha256,
      watermarkedSha256,
      psdSha256,
      pdfSha256,
    },
    watermark: {
      strength: embedded.stats.strength,
      totalBlocks: embedded.stats.totalBlocks,
      repetitionsPerBit: embedded.stats.repetitionsPerBit,
      changedBlocks: embedded.stats.changedBlocks,
      skippedBlocks: embedded.stats.skippedBlocks,
      localVerification: {
        ...comparison,
        confidence: extracted.confidence,
        minimumBitConfidence: extracted.minimumBitConfidence,
      },
      psnr: Number(psnr.toFixed(4)),
    },
    files: {
      original: input.originalPath,
      watermarked: input.watermarkedPath,
      psd: input.psdPath,
      pdf: input.pdfPath,
      evidence: input.evidencePath,
    },
    createdAt: new Date().toISOString(),
  };
  await writeFile(input.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

if (!isMainThread && parentPort) {
  processImageProvenanceEvidence(workerData)
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((error) => parentPort.postMessage({
      ok: false,
      error: {
        code: error?.code || 'IMAGE_PROVENANCE_WORKER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stack: error?.stack || '',
      },
    }));
}
