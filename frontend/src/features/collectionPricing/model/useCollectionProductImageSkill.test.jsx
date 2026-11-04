import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  fallback: {
    id: 'ozon-product-image-generation',
    title: 'Ozon 商品图生成',
    promptConfig: { systemPrompt: 'default rules' },
  },
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../services/collectionProductImageSkillService.js', () => ({
  getDefaultCollectionProductImageSkill: () => service.fallback,
  loadCollectionProductImageSkill: service.load,
  saveCollectionProductImageSkillEditorForm: service.save,
}));

import { useCollectionProductImageSkill } from './useCollectionProductImageSkill.js';

describe('useCollectionProductImageSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.load.mockResolvedValue({
      ...service.fallback,
      promptConfig: { systemPrompt: 'saved rules' },
    });
    service.save.mockResolvedValue({
      ...service.fallback,
      promptConfig: { systemPrompt: 'edited rules' },
    });
  });

  it('shows default rules immediately and refreshes the saved Skill rules', async () => {
    const { result } = renderHook(() => useCollectionProductImageSkill(true));
    expect(result.current.skill.promptConfig.systemPrompt).toBe('default rules');
    await waitFor(() => expect(result.current.skill.promptConfig.systemPrompt).toBe('saved rules'));
    expect(result.current.status).toBe('ready');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(service.load).toHaveBeenCalledTimes(2));

    await act(async () => {
      await result.current.save({ systemPrompt: 'edited rules' });
    });
    expect(result.current.skill.promptConfig.systemPrompt).toBe('edited rules');
  });
});
