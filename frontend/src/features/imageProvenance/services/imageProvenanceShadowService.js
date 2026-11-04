import { requestLocalApi } from '../../../api/localApiClient.js';

function text(value) {
  return String(value ?? '').trim();
}

export function queueGeneratedImageProvenanceShadow(input = {}) {
  const shopId = text(input.shopId);
  const sourceAssetId = text(input.sourceAssetId);
  const sourceTaskId = text(input.sourceTaskId);
  if (!shopId || (!sourceAssetId && !sourceTaskId)) return Promise.resolve(null);
  return requestLocalApi('/api/image-provenance/jobs', {
    method: 'POST',
    body: {
      shopId,
      sourceAssetId,
      sourceTaskId,
      sourceType: text(input.sourceType) || 'generated-image-shadow',
      rightsOwner: text(input.rightsOwner),
      generation: {
        model: text(input.model),
        accountId: text(input.accountId),
        prompt: text(input.prompt),
        generationMode: text(input.generationMode),
        productId: text(input.productId),
        offerId: text(input.offerId),
      },
    },
    timeoutMs: 5_000,
    transportRetry: false,
    observe: false,
  }).catch(() => null);
}

export function scheduleGeneratedImageProvenanceShadow(input = {}) {
  void queueGeneratedImageProvenanceShadow(input);
}
