import assert from 'node:assert/strict';
import test from 'node:test';
import { isImageGenerationModel } from './modelApiCapabilities.js';

test('recognizes dynamic image model families without treating text, video, or vision-only models as generators', () => {
  assert.equal(isImageGenerationModel({ id: 'gpt-image-2' }), true);
  assert.equal(isImageGenerationModel({ id: 'gpt-image-2-adobe' }), true);
  assert.equal(isImageGenerationModel({ id: 'gemini-banana-2.0-pro' }), true);
  assert.equal(isImageGenerationModel({ id: 'future-image-model', endpoints: ['images/generations'] }), true);
  assert.equal(isImageGenerationModel({ id: 'gpt-5-4-thinking', capabilities: ['text-generation'] }), false);
  assert.equal(isImageGenerationModel({ id: 'seedance-2.0' }), false);
  assert.equal(isImageGenerationModel({ id: 'vision-reader', capabilities: ['multimodal'] }), false);
});
