import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVED_IMAGE_API_BASE_URL,
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageProvider,
} from './imageGenerationProviderPolicy.js';

test('image generation policy accepts only the fixed API and model', () => {
  assert.equal(
    isApprovedImageProvider(APPROVED_IMAGE_API_BASE_URL, APPROVED_IMAGE_MODEL_ID),
    true,
  );
  assert.equal(
    isApprovedImageProvider(`${APPROVED_IMAGE_API_BASE_URL}/`, APPROVED_IMAGE_MODEL_ID),
    true,
  );
  assert.equal(
    isApprovedImageProvider('https://direct.images.example.invalid/v1', APPROVED_IMAGE_MODEL_ID),
    false,
  );
  assert.equal(
    isApprovedImageProvider('https://images.example.invalid/v1/extra', APPROVED_IMAGE_MODEL_ID),
    false,
  );
  assert.equal(
    isApprovedImageProvider(APPROVED_IMAGE_API_BASE_URL, 'gpt-image-2-adobe'),
    false,
  );
  assert.equal(
    isApprovedImageProvider(APPROVED_IMAGE_API_BASE_URL, 'gemini-banana'),
    false,
  );
});
