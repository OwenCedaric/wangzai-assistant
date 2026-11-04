import { describe, expect, it } from 'vitest';
import { filterImageGenerationModels, isImageGenerationModel } from './modelCapabilityRules.js';

describe('modelCapabilityRules', () => {
  it('keeps dynamically discovered image model families and excludes text and video models', () => {
    const models = [
      { id: 'gpt-5-4-thinking', capabilities: ['text-generation'] },
      { id: 'seedance-2.0', capabilities: [] },
      { id: 'gpt-image-2', capabilities: ['image-generation'] },
      { id: 'gpt-image-2-adobe', capabilities: ['image-edit'] },
      { id: 'gemini-banana-2.0-pro', capabilities: ['text-generation'] },
      { id: 'grok-video-1.5', capabilities: [] },
    ];

    expect(filterImageGenerationModels(models).map((model) => model.id)).toEqual([
      'gpt-image-2',
      'gpt-image-2-adobe',
      'gemini-banana-2.0-pro',
    ]);
  });

  it('trusts explicit image-generation endpoints without relying on a fixed model id list', () => {
    expect(isImageGenerationModel({ id: 'future-model', supported_endpoints: ['images/generations'] })).toBe(true);
    expect(isImageGenerationModel({ id: 'vision-reader', capabilities: ['multimodal'] })).toBe(false);
  });
});
