import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVED_IMAGE_API_BASE_URL,
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageProvider,
} from './imageGenerationProviderPolicy.js';

test('local image execution accepts only the approved endpoint and model', () => {
  const account = { baseUrl: APPROVED_IMAGE_API_BASE_URL };
  assert.equal(isApprovedImageProvider(account, APPROVED_IMAGE_MODEL_ID), true);
  assert.equal(
    isApprovedImageProvider({ baseUrl: 'https://direct.images.example.invalid/v1' }, APPROVED_IMAGE_MODEL_ID),
    false,
  );
  assert.equal(isApprovedImageProvider(account, 'gpt-image-2-adobe'), false);
  assert.equal(isApprovedImageProvider(account, 'gemini-banana'), false);
});
