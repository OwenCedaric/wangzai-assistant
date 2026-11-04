import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWatermarkProfileSetting: vi.fn(),
  hydrateWatermarkAssetReferences: vi.fn(),
  prepareWatermarkProfileSetting: vi.fn(),
  saveWatermarkProfileSetting: vi.fn(),
}));

vi.mock('./watermarkProfileSettingsService.js', () => ({
  getWatermarkProfileSetting: mocks.getWatermarkProfileSetting,
  hydrateWatermarkAssetReferences: mocks.hydrateWatermarkAssetReferences,
  prepareWatermarkProfileSetting: mocks.prepareWatermarkProfileSetting,
  saveWatermarkProfileSetting: mocks.saveWatermarkProfileSetting,
}));

const RETIRED_TEMPLATE_KEY = 'wangzai-watermark-templates';
const RETIRED_ACTIVE_TEMPLATE_KEY = 'wangzai-active-watermark-template-id';

let watermarkRuntime;

beforeEach(async () => {
  globalThis.localStorage.clear();
  vi.clearAllMocks();
  vi.resetModules();
  watermarkRuntime = await import('./productEditing.jsx');
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe('watermark profile settings local-api boundary', () => {
  it('reads only an existing canonical profile and leaves retired browser bytes untouched', async () => {
    const canonicalStore = {
      activeTemplateId: 'watermark-detail-bottom',
      templates: [{ id: 'watermark-detail-bottom', name: '详情页底部水印' }],
    };
    globalThis.localStorage.setItem(RETIRED_TEMPLATE_KEY, JSON.stringify([{ id: 'legacy-only-template' }]));
    globalThis.localStorage.setItem(RETIRED_ACTIVE_TEMPLATE_KEY, 'watermark-detail-bottom');
    mocks.getWatermarkProfileSetting.mockResolvedValue({ setting: { value: canonicalStore } });
    mocks.hydrateWatermarkAssetReferences.mockResolvedValue(canonicalStore);

    const state = await watermarkRuntime.loadWatermarkSettingsFromLocalApi();

    expect(state).toEqual(canonicalStore);
    expect(mocks.getWatermarkProfileSetting).toHaveBeenCalledTimes(1);
    expect(mocks.prepareWatermarkProfileSetting).not.toHaveBeenCalled();
    expect(mocks.saveWatermarkProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_TEMPLATE_KEY)).not.toBeNull();
    expect(globalThis.localStorage.getItem(RETIRED_ACTIVE_TEMPLATE_KEY)).toBe('watermark-detail-bottom');
  });

  it('uses defaults without reading or migrating either retired browser value when SQLite has no profile', async () => {
    globalThis.localStorage.setItem(RETIRED_TEMPLATE_KEY, JSON.stringify([{ id: 'legacy-only-template' }]));
    globalThis.localStorage.setItem(RETIRED_ACTIVE_TEMPLATE_KEY, 'watermark-detail-bottom');
    mocks.getWatermarkProfileSetting.mockResolvedValue({ setting: null });

    const state = await watermarkRuntime.loadWatermarkSettingsFromLocalApi();

    expect(state.templates.map((template) => template.id)).toEqual([
      'watermark-main-default',
      'watermark-promo-corner',
      'watermark-detail-bottom',
    ]);
    expect(state.activeTemplateId).toBe('watermark-main-default');
    expect(mocks.getWatermarkProfileSetting).toHaveBeenCalledTimes(1);
    expect(mocks.prepareWatermarkProfileSetting).not.toHaveBeenCalled();
    expect(mocks.saveWatermarkProfileSetting).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(RETIRED_TEMPLATE_KEY)).not.toBeNull();
    expect(globalThis.localStorage.getItem(RETIRED_ACTIVE_TEMPLATE_KEY)).toBe('watermark-detail-bottom');
  });

  it('saves later template edits through prepared local-api asset references only', async () => {
    const nextStore = {
      activeTemplateId: 'watermark-main-default',
      templates: [{ id: 'watermark-main-default', name: '主图默认水印' }],
    };
    mocks.prepareWatermarkProfileSetting.mockResolvedValue({
      runtimeStore: nextStore,
      persistedValue: nextStore,
    });
    mocks.saveWatermarkProfileSetting.mockResolvedValue({ setting: { value: nextStore } });

    const returned = watermarkRuntime.saveWatermarkTemplates(nextStore.templates, nextStore.activeTemplateId);
    await vi.waitFor(() => expect(mocks.saveWatermarkProfileSetting).toHaveBeenCalledWith(nextStore));

    expect(returned.activeTemplateId).toBe(nextStore.activeTemplateId);
    expect(mocks.prepareWatermarkProfileSetting).toHaveBeenCalledWith(expect.any(Object), expect.any(Function));
  });
});
