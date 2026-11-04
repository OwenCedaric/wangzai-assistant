import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserModelPresets, updateUserModelPresets } from '../../licensing/services/licenseCenterClient.js';
import {
  createModelPresetDraft,
  loadPointsModelPresets,
  normalizeModelPresetCatalog,
  savePointsModelPresets,
} from './pointsPackageModelPresetService.js';

vi.mock('../../licensing/services/licenseCenterClient.js', () => ({
  getUserModelPresets: vi.fn(),
  updateUserModelPresets: vi.fn(),
}));

const payload = {
  contract: 'user-model-preset/v1',
  project_code: 'wangzai_desktop',
  groups: [
    {
      capability_kind: 'text',
      label: '文本模型',
      enabled_models: ['gpt-5.6-sol'],
      default_model: 'gpt-5.6-sol',
      updated_at: null,
      models: [
        {
          model_code: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          api_status: 'available',
          configured_api_count: 5,
          available_api_count: 4,
          busy_api_count: 1,
          cooling_api_count: 0,
          priced_capability_count: 4,
          total_capability_count: 4,
          can_enable: true,
          unavailable_reason: null,
        },
        {
          model_code: 'gpt-5.6-terra',
          display_name: 'GPT-5.6-Terra',
          api_status: 'available',
          configured_api_count: 5,
          available_api_count: 5,
          busy_api_count: 0,
          cooling_api_count: 0,
          priced_capability_count: 4,
          total_capability_count: 4,
          can_enable: true,
          unavailable_reason: null,
        },
        {
          model_code: 'gpt-5.4-mini',
          display_name: 'GPT-5.4-Mini',
          api_status: 'unavailable',
          configured_api_count: 0,
          available_api_count: 0,
          priced_capability_count: 0,
          total_capability_count: 4,
          can_enable: false,
          unavailable_reason: '模型或 API 服务已停用',
        },
      ],
    },
    {
      capability_kind: 'image',
      label: '图片模型',
      enabled_models: ['gpt-image-2'],
      default_model: 'gpt-image-2',
      updated_at: null,
      models: [
        {
          model_code: 'gpt-image-2',
          display_name: 'GPT Image 2',
          api_status: 'available',
          configured_api_count: 5,
          available_api_count: 5,
          busy_api_count: 0,
          cooling_api_count: 0,
          priced_capability_count: 2,
          total_capability_count: 2,
          can_enable: true,
          unavailable_reason: null,
        },
        {
          model_code: 'gpt-image-2-adobe',
          display_name: 'GPT Image 2 Adobe',
          api_status: 'available',
          configured_api_count: 5,
          available_api_count: 5,
          priced_capability_count: 2,
          total_capability_count: 2,
          can_enable: true,
          unavailable_reason: null,
        },
      ],
    },
  ],
};

describe('points package model preset service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes API capacity without exposing provider keys', () => {
    const catalog = normalizeModelPresetCatalog(payload);
    expect(catalog.groups).toHaveLength(2);
    expect(catalog.groups[0].models[0]).toMatchObject({
      modelCode: 'gpt-5.6-sol',
      configuredApiCount: 5,
      availableApiCount: 4,
      busyApiCount: 1,
      canEnable: true,
    });
    expect(JSON.stringify(catalog)).not.toContain('api_key');
    expect(catalog.groups[0].models.map((item) => item.modelCode)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(catalog.groups[1].models.map((item) => item.modelCode)).toEqual(['gpt-image-2']);
    expect(createModelPresetDraft(catalog)[0].enabledModels).toEqual(['gpt-5.6-sol']);
  });

  it('loads and saves account-level groups through the license center client', async () => {
    const runtime = { projectCode: 'wangzai_desktop' };
    getUserModelPresets.mockResolvedValue(payload);
    updateUserModelPresets.mockResolvedValue(payload);
    const catalog = await loadPointsModelPresets(runtime);
    await savePointsModelPresets(runtime, createModelPresetDraft(catalog));
    expect(getUserModelPresets).toHaveBeenCalledWith(runtime);
    expect(updateUserModelPresets).toHaveBeenCalledWith(runtime, [
      {
        capability_kind: 'text',
        enabled_models: ['gpt-5.6-sol'],
        default_model: 'gpt-5.6-sol',
      },
      {
        capability_kind: 'image',
        enabled_models: ['gpt-image-2'],
        default_model: 'gpt-image-2',
      },
    ]);
  });
});
