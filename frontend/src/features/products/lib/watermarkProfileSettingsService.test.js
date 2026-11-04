import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileAsset: vi.fn(),
  saveProfileAsset: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileAsset: mocks.getProfileAsset,
  saveProfileAsset: mocks.saveProfileAsset,
}));

import {
  hydrateWatermarkAssetReferences,
  parseWatermarkDataUrl,
  prepareWatermarkProfileSetting,
} from './watermarkProfileSettingsService.js';

function normalizeStore(value = {}) {
  return {
    templates: Array.isArray(value.templates) ? value.templates.map((item) => ({ imageAssetId: '', imageDataUrl: '', ...item })) : [],
    activeTemplateId: value.activeTemplateId || '',
  };
}

afterEach(() => vi.clearAllMocks());

describe('watermark profile settings asset references', () => {
  it('parses only allowed image data URLs', () => {
    expect(parseWatermarkDataUrl('data:image/png;base64,aGVsbG8=')).toEqual({ mimeType: 'image/png', dataBase64: 'aGVsbG8=' });
    expect(() => parseWatermarkDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toThrow(/PNG、JPEG 或 WebP/u);
  });

  it('uploads new image data once and keeps base64 out of the profile-settings payload', async () => {
    mocks.saveProfileAsset.mockResolvedValue({ asset: { id: 'asset_hash', mimeType: 'image/png' } });
    const prepared = await prepareWatermarkProfileSetting({
      activeTemplateId: 'template-a',
      templates: [{ id: 'template-a', name: '主模板', imageDataUrl: 'data:image/png;base64,aGVsbG8=' }],
    }, normalizeStore);

    expect(mocks.saveProfileAsset).toHaveBeenCalledWith(
      { mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
      { timeoutMs: 30000, signal: undefined }
    );
    expect(prepared.runtimeStore.templates[0]).toMatchObject({ imageAssetId: 'asset_hash', imageDataUrl: 'data:image/png;base64,aGVsbG8=' });
    expect(prepared.persistedValue.templates[0]).toMatchObject({ imageAssetId: 'asset_hash' });
    expect(prepared.persistedValue.templates[0]).not.toHaveProperty('imageDataUrl');
  });

  it('deduplicates a shared watermark image before preparing many template asset references', async () => {
    mocks.saveProfileAsset.mockResolvedValue({ asset: { id: 'asset_shared', mimeType: 'image/png' } });
    const prepared = await prepareWatermarkProfileSetting({
      activeTemplateId: 'template-17',
      templates: Array.from({ length: 17 }, (_, index) => ({
        id: `template-${index + 1}`,
        name: `模板 ${index + 1}`,
        imageDataUrl: 'data:image/png;base64,aGVsbG8=',
      })),
    }, normalizeStore);

    expect(mocks.saveProfileAsset).toHaveBeenCalledTimes(1);
    expect(prepared.runtimeStore.templates).toHaveLength(17);
    expect(prepared.runtimeStore.templates.every((template) => template.imageAssetId === 'asset_shared')).toBe(true);
    expect(prepared.persistedValue.templates.every((template) => template.imageAssetId === 'asset_shared')).toBe(true);
    expect(prepared.persistedValue.templates.every((template) => !Object.hasOwn(template, 'imageDataUrl'))).toBe(true);
  });

  it('hydrates preview-only data URLs from explicit asset reads', async () => {
    mocks.getProfileAsset.mockResolvedValue({ asset: { id: 'asset_hash', mimeType: 'image/png', dataBase64: 'aGVsbG8=' } });
    const hydrated = await hydrateWatermarkAssetReferences({
      activeTemplateId: 'template-a',
      templates: [{ id: 'template-a', imageAssetId: 'asset_hash' }],
    }, normalizeStore);

    expect(hydrated.templates[0].imageDataUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(mocks.getProfileAsset).toHaveBeenCalledWith('asset_hash', { timeoutMs: 30000, signal: undefined });
  });
});
