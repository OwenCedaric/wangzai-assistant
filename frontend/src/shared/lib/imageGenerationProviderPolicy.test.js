import { describe, expect, it } from 'vitest';

import {
  APPROVED_IMAGE_API_BASE_URL,
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageApiBaseUrl,
  isApprovedImageModel,
} from './imageGenerationProviderPolicy.js';

describe('image generation provider policy', () => {
  it('allows only images.example.invalid/v1 and gpt-image-2', () => {
    expect(isApprovedImageApiBaseUrl(APPROVED_IMAGE_API_BASE_URL)).toBe(true);
    expect(isApprovedImageApiBaseUrl(`${APPROVED_IMAGE_API_BASE_URL}/`)).toBe(true);
    expect(isApprovedImageApiBaseUrl('https://direct.images.example.invalid/v1')).toBe(false);
    expect(isApprovedImageApiBaseUrl('https://images.example.invalid/v1/extra')).toBe(false);
    expect(isApprovedImageModel(APPROVED_IMAGE_MODEL_ID)).toBe(true);
    expect(isApprovedImageModel('gpt-image-2-adobe')).toBe(false);
    expect(isApprovedImageModel('gemini-banana')).toBe(false);
  });
});
