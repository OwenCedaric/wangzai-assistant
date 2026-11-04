import assert from 'node:assert/strict';
import test from 'node:test';
import { readPsd } from 'ag-psd';
import { createEvidencePsd } from './imageEvidencePsd.js';

test('creates a readable evidence PSD with four named layers', async () => {
  const width = 128;
  const height = 128;
  const original = Buffer.alloc(width * height * 4, 0);
  const watermarked = Buffer.alloc(width * height * 4, 0);
  for (let index = 0; index < original.length; index += 4) {
    original[index] = 120;
    original[index + 1] = 180;
    original[index + 2] = 220;
    original[index + 3] = 255;
    watermarked.set(original.subarray(index, index + 4), index);
  }
  const psdBuffer = await createEvidencePsd({
    originalRgba: original,
    watermarkedRgba: watermarked,
    width,
    height,
    metadata: { assetToken: 'abc', createdAt: '2026-08-14T00:00:00.000Z' },
  });
  const parsed = readPsd(psdBuffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  assert.equal(parsed.width, width);
  assert.equal(parsed.height, height);
  assert.deepEqual(parsed.children.map((layer) => layer.name), [
    '00 原始生成图',
    '01 人工修改或处理结果（当前无独立修改层）',
    '02 暗水印发布图',
    '03 图片编号与权属证据信息（默认隐藏）',
  ]);
  assert.notEqual(parsed.children[2].hidden, true);
  assert.equal(parsed.children[3].hidden, true);
});
