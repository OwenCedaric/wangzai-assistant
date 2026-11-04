import { createHash } from 'node:crypto';

export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_DIMENSION = 12_000;
export const PRODUCT_IMAGE_MAX_PIXELS = 40_000_000;

function pngDimensions(data) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mimeType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegDimensions(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 4 > data.length) break;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { mimeType: 'image/jpeg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(data) {
  if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = data.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      mimeType: 'image/webp',
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return {
      mimeType: 'image/webp',
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return {
      mimeType: 'image/webp',
      width: data.readUInt16LE(26) & 0x3fff,
      height: data.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function inspectHeader(data) {
  return pngDimensions(data) || jpegDimensions(data) || webpDimensions(data);
}

export function validateProductImageBuffer({ data, mimeType } = {}, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : PRODUCT_IMAGE_MAX_BYTES;
  const maxDimension = Number(options.maxDimension) > 0 ? Number(options.maxDimension) : PRODUCT_IMAGE_MAX_DIMENSION;
  const maxPixels = Number(options.maxPixels) > 0 ? Number(options.maxPixels) : PRODUCT_IMAGE_MAX_PIXELS;
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('图片内容为空。');
  if (data.byteLength > maxBytes) throw new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)}MB。`);
  const header = inspectHeader(data);
  if (!header) throw new Error('图片文件头无效，只支持真实的 PNG、JPEG 或 WebP 文件。');
  const declaredMime = String(mimeType || '').trim().toLowerCase();
  if (declaredMime !== header.mimeType) throw new Error('图片文件头与声明格式不一致。');
  if (!header.width || !header.height || header.width > maxDimension || header.height > maxDimension) {
    throw new Error(`图片宽高无效或超过 ${maxDimension}px。`);
  }
  if (header.width * header.height > maxPixels) throw new Error('图片总像素超过安全上限。');
  return {
    ...header,
    byteLength: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}
