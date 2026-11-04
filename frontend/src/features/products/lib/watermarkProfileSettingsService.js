import { getProfileAsset, getProfileSetting, saveProfileAsset, saveProfileSetting } from '../../../api/localApiClient.js';

export const PROFILE_WATERMARK_SETTINGS_NAMESPACE = 'watermark-settings';

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function parseWatermarkDataUrl(value) {
  const dataUrl = normalizeText(value);
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) throw new Error('水印图片必须是 PNG、JPEG 或 WebP data URL。');
  return { mimeType: match[1], dataBase64: match[2] };
}

export function assetToWatermarkDataUrl(asset = {}) {
  const mimeType = normalizeText(asset.mimeType);
  const dataBase64 = normalizeText(asset.dataBase64);
  if (!mimeType || !dataBase64) throw new Error('水印图片资产内容不完整。');
  return `data:${mimeType};base64,${dataBase64}`;
}

export async function uploadWatermarkDataUrl(dataUrl, options = {}) {
  const payload = parseWatermarkDataUrl(dataUrl);
  const saved = await saveProfileAsset(payload, { timeoutMs: options.timeoutMs || 30000, signal: options.signal });
  if (!saved?.asset?.id) throw new Error('local-api 未返回水印图片资产。');
  return saved.asset;
}

export async function hydrateWatermarkAssetReferences(store, normalizeStore, options = {}) {
  const normalized = normalizeStore(store);
  const cache = options.assetCache || new Map();
  const templates = [];
  for (const template of normalized.templates) {
    const imageAssetId = normalizeText(template.imageAssetId);
    if (!imageAssetId) {
      templates.push(template);
      continue;
    }
    let asset = cache.get(imageAssetId);
    if (!asset) {
      const response = await getProfileAsset(imageAssetId, { timeoutMs: options.timeoutMs || 30000, signal: options.signal });
      asset = response?.asset;
      if (!asset?.id || asset.id !== imageAssetId) throw new Error(`水印图片资产缺失：${imageAssetId}`);
      cache.set(imageAssetId, asset);
    }
    templates.push({ ...template, imageDataUrl: assetToWatermarkDataUrl(asset) });
  }
  return normalizeStore({ ...normalized, templates });
}

/** Uploads new data URLs first, then builds the small profile-settings payload with asset references only. */
export async function prepareWatermarkProfileSetting(store, normalizeStore, options = {}) {
  const normalized = normalizeStore(store);
  const runtimeTemplates = [];
  const persistedTemplates = [];
  const assetByDataUrl = new Map();
  for (const template of normalized.templates) {
    let imageAssetId = normalizeText(template.imageAssetId);
    let imageDataUrl = normalizeText(template.imageDataUrl);
    if (imageDataUrl && !imageAssetId) {
      let assetPromise = assetByDataUrl.get(imageDataUrl);
      if (!assetPromise) {
        assetPromise = uploadWatermarkDataUrl(imageDataUrl, options);
        assetByDataUrl.set(imageDataUrl, assetPromise);
      }
      const asset = await assetPromise;
      imageAssetId = asset.id;
    }
    runtimeTemplates.push({ ...template, imageAssetId, imageDataUrl });
    const { imageDataUrl: _runtimeOnlyDataUrl, ...persisted } = { ...template, imageAssetId };
    persistedTemplates.push(persisted);
  }
  return {
    runtimeStore: normalizeStore({ ...normalized, templates: runtimeTemplates }),
    persistedValue: { ...normalized, templates: persistedTemplates },
  };
}

export async function getWatermarkProfileSetting(options = {}) {
  return getProfileSetting(PROFILE_WATERMARK_SETTINGS_NAMESPACE, { timeoutMs: options.timeoutMs || 10000, signal: options.signal });
}

export async function saveWatermarkProfileSetting(value, options = {}) {
  return saveProfileSetting(PROFILE_WATERMARK_SETTINGS_NAMESPACE, value, { timeoutMs: options.timeoutMs || 30000, signal: options.signal });
}
