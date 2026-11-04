const PAYLOAD_BYTES = 32;
const PAYLOAD_BITS = PAYLOAD_BYTES * 8;
const BLOCK_SIZE = 8;
const COEFFICIENT_PAIRS = Object.freeze([
  [[2, 3], [3, 2]],
  [[1, 3], [3, 1]],
  [[2, 4], [4, 2]],
  [[1, 4], [4, 1]],
]);

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function dctBasis(frequency, position) {
  const alpha = frequency === 0 ? 1 / Math.sqrt(BLOCK_SIZE) : Math.sqrt(2 / BLOCK_SIZE);
  return alpha * Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * BLOCK_SIZE));
}

const COEFFICIENT_BASIS = Object.freeze(Object.fromEntries(
  [...new Set(COEFFICIENT_PAIRS.flat().map(([u, v]) => `${u}:${v}`))]
    .map((key) => {
      const [u, v] = key.split(':').map(Number);
      const values = [];
      for (let y = 0; y < BLOCK_SIZE; y += 1) {
        for (let x = 0; x < BLOCK_SIZE; x += 1) {
          values.push(dctBasis(u, x) * dctBasis(v, y));
        }
      }
      return [key, Object.freeze(values)];
    }),
));

function coefficientBasis(u, v) {
  const key = `${u}:${v}`;
  const values = COEFFICIENT_BASIS[key];
  if (!values) throw new Error(`Unsupported DCT coefficient pair: ${key}`);
  return values;
}

function normalizePayload(payload) {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  if (value.byteLength !== PAYLOAD_BYTES) {
    throw new Error(`Watermark payload must contain exactly ${PAYLOAD_BYTES} bytes.`);
  }
  return value;
}

export function watermarkPayloadToBits(payload) {
  const value = normalizePayload(payload);
  const bits = new Uint8Array(PAYLOAD_BITS);
  for (let byteIndex = 0; byteIndex < value.byteLength; byteIndex += 1) {
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      bits[byteIndex * 8 + bitIndex] = (value[byteIndex] >> (7 - bitIndex)) & 1;
    }
  }
  return bits;
}

export function watermarkBitsToPayload(bits) {
  if (!bits || bits.length !== PAYLOAD_BITS) {
    throw new Error(`Watermark bit array must contain exactly ${PAYLOAD_BITS} bits.`);
  }
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  for (let bitIndex = 0; bitIndex < PAYLOAD_BITS; bitIndex += 1) {
    payload[Math.floor(bitIndex / 8)] |= (bits[bitIndex] & 1) << (7 - (bitIndex % 8));
  }
  return payload;
}

function assertRawImage(image = {}) {
  const width = Number(image.width);
  const height = Number(image.height);
  const channels = Number(image.channels || 4);
  const data = image.data;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 128 || height < 128) {
    throw new Error('Watermark image must be at least 128×128 pixels.');
  }
  if (![3, 4].includes(channels) || !data || data.byteLength < width * height * channels) {
    throw new Error('Watermark image must contain packed RGB or RGBA pixels.');
  }
  return { width, height, channels, data };
}

function bitIndexForBlock(blockOrdinal) {
  return (blockOrdinal * 73 + 19) & (PAYLOAD_BITS - 1);
}

function blockCoefficient(image, blockX, blockY, basis) {
  const { width, channels, data } = image;
  let coefficient = 0;
  for (let y = 0; y < BLOCK_SIZE; y += 1) {
    const rowOffset = (blockY + y) * width;
    for (let x = 0; x < BLOCK_SIZE; x += 1) {
      const pixelOffset = (rowOffset + blockX + x) * channels;
      const luminance = 0.299 * data[pixelOffset]
        + 0.587 * data[pixelOffset + 1]
        + 0.114 * data[pixelOffset + 2];
      coefficient += luminance * basis[y * BLOCK_SIZE + x];
    }
  }
  return coefficient;
}

function adjustBlock(image, blockX, blockY, basisA, basisB, coefficientDelta) {
  const { width, channels, data } = image;
  const halfDelta = coefficientDelta / 2;
  for (let y = 0; y < BLOCK_SIZE; y += 1) {
    const rowOffset = (blockY + y) * width;
    for (let x = 0; x < BLOCK_SIZE; x += 1) {
      const basisIndex = y * BLOCK_SIZE + x;
      const luminanceDelta = halfDelta * (basisA[basisIndex] - basisB[basisIndex]);
      const pixelOffset = (rowOffset + blockX + x) * channels;
      data[pixelOffset] = clampByte(data[pixelOffset] + luminanceDelta);
      data[pixelOffset + 1] = clampByte(data[pixelOffset + 1] + luminanceDelta);
      data[pixelOffset + 2] = clampByte(data[pixelOffset + 2] + luminanceDelta);
    }
  }
}

export function embedDctWatermark(rawImage, payload, options = {}) {
  const source = assertRawImage(rawImage);
  const bits = watermarkPayloadToBits(payload);
  const strength = Math.max(8, Math.min(48, Number(options.strength) || 20));
  const maximumNaturalDifference = Math.max(strength * 2, Number(options.maximumNaturalDifference) || 72);
  const output = {
    ...source,
    data: Buffer.from(source.data),
  };
  let blockOrdinal = 0;
  let changedBlocks = 0;
  let skippedBlocks = 0;
  for (let blockY = 0; blockY + BLOCK_SIZE <= output.height; blockY += BLOCK_SIZE) {
    for (let blockX = 0; blockX + BLOCK_SIZE <= output.width; blockX += BLOCK_SIZE) {
      const pair = COEFFICIENT_PAIRS[Math.floor(blockOrdinal / PAYLOAD_BITS) % COEFFICIENT_PAIRS.length];
      const basisA = coefficientBasis(pair[0][0], pair[0][1]);
      const basisB = coefficientBasis(pair[1][0], pair[1][1]);
      const coefficientA = blockCoefficient(output, blockX, blockY, basisA);
      const coefficientB = blockCoefficient(output, blockX, blockY, basisB);
      const difference = coefficientA - coefficientB;
      const bit = bits[bitIndexForBlock(blockOrdinal)];
      const desiredDifference = bit ? strength : -strength;
      const alreadyEncoded = bit ? difference >= strength : difference <= -strength;
      if (!alreadyEncoded) {
        if (Math.abs(difference) > maximumNaturalDifference) {
          skippedBlocks += 1;
        } else {
          adjustBlock(output, blockX, blockY, basisA, basisB, desiredDifference - difference);
          changedBlocks += 1;
        }
      }
      blockOrdinal += 1;
    }
  }
  if (blockOrdinal < PAYLOAD_BITS * 2) {
    throw new Error('Watermark image does not contain enough DCT blocks for a 256-bit payload.');
  }
  return {
    ...output,
    stats: {
      algorithm: 'wangzai-dct-pair-v1',
      strength,
      totalBlocks: blockOrdinal,
      changedBlocks,
      skippedBlocks,
      repetitionsPerBit: blockOrdinal / PAYLOAD_BITS,
    },
  };
}

export function extractDctWatermark(rawImage, options = {}) {
  const source = assertRawImage(rawImage);
  const scores = new Float64Array(PAYLOAD_BITS);
  const magnitudes = new Float64Array(PAYLOAD_BITS);
  const votes = new Uint32Array(PAYLOAD_BITS);
  let blockOrdinal = 0;
  for (let blockY = 0; blockY + BLOCK_SIZE <= source.height; blockY += BLOCK_SIZE) {
    for (let blockX = 0; blockX + BLOCK_SIZE <= source.width; blockX += BLOCK_SIZE) {
      const pair = COEFFICIENT_PAIRS[Math.floor(blockOrdinal / PAYLOAD_BITS) % COEFFICIENT_PAIRS.length];
      const basisA = coefficientBasis(pair[0][0], pair[0][1]);
      const basisB = coefficientBasis(pair[1][0], pair[1][1]);
      const difference = blockCoefficient(source, blockX, blockY, basisA)
        - blockCoefficient(source, blockX, blockY, basisB);
      const bitIndex = bitIndexForBlock(blockOrdinal);
      // Use a bounded signed vote instead of raw coefficient magnitude. A
      // naturally strong edge in one block must not outweigh the repeated
      // payload votes spread across the rest of the image.
      const boundedVote = Math.sign(difference || 1) * Math.min(1, Math.abs(difference) / 8);
      scores[bitIndex] += boundedVote;
      magnitudes[bitIndex] += Math.abs(boundedVote);
      votes[bitIndex] += 1;
      blockOrdinal += 1;
    }
  }
  const bits = new Uint8Array(PAYLOAD_BITS);
  let confidenceTotal = 0;
  let minimumConfidence = 1;
  for (let bitIndex = 0; bitIndex < PAYLOAD_BITS; bitIndex += 1) {
    bits[bitIndex] = scores[bitIndex] >= 0 ? 1 : 0;
    const confidence = magnitudes[bitIndex] > 0
      ? Math.min(1, Math.abs(scores[bitIndex]) / magnitudes[bitIndex])
      : 0;
    confidenceTotal += confidence;
    minimumConfidence = Math.min(minimumConfidence, confidence);
  }
  return {
    payload: watermarkBitsToPayload(bits),
    bits,
    confidence: confidenceTotal / PAYLOAD_BITS,
    minimumBitConfidence: minimumConfidence,
    totalBlocks: blockOrdinal,
    repetitionsPerBit: blockOrdinal / PAYLOAD_BITS,
    votes,
  };
}

export function compareWatermarkPayload(actual, expected) {
  const actualBits = watermarkPayloadToBits(actual);
  const expectedBits = watermarkPayloadToBits(expected);
  let matchingBits = 0;
  for (let index = 0; index < PAYLOAD_BITS; index += 1) {
    if (actualBits[index] === expectedBits[index]) matchingBits += 1;
  }
  return {
    matchingBits,
    totalBits: PAYLOAD_BITS,
    bitAccuracy: matchingBits / PAYLOAD_BITS,
    exact: matchingBits === PAYLOAD_BITS,
  };
}

export const imageWatermarkContract = Object.freeze({
  algorithm: 'wangzai-dct-pair-v1',
  payloadBytes: PAYLOAD_BYTES,
  payloadBits: PAYLOAD_BITS,
  minimumImageSize: 128,
});
