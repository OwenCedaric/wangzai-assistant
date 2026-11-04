import { createPurchasePlatformAdapter } from './basePurchasePlatformAdapter.js';
import { platform1688Adapter } from './platform1688Adapter.js';
import { pinduoduoAdapter } from './pinduoduoAdapter.js';
import { ozonBuyerAdapter } from './ozonBuyerAdapter.js';
import { taobaoAdapter } from './taobaoAdapter.js';
import { tmallAdapter } from './tmallAdapter.js';
import {
  aliExpressAdapter,
  amazonAdapter,
  jdAdapter,
  temuAdapter,
  wildberriesAdapter,
} from './marketplaceAdapters.js';

export const PURCHASE_PLATFORM_ADAPTERS = Object.freeze([
  platform1688Adapter,
  tmallAdapter,
  taobaoAdapter,
  pinduoduoAdapter,
  ozonBuyerAdapter,
  jdAdapter,
  wildberriesAdapter,
  amazonAdapter,
  temuAdapter,
  aliExpressAdapter,
]);

const unknownAdapter = createPurchasePlatformAdapter({
  id: 'unknown',
  label: 'unknown',
  hosts: [],
  aliases: [],
});

export function resolvePurchasePlatformAdapter(context = {}) {
  const scores = PURCHASE_PLATFORM_ADAPTERS.map((adapter) => ({
    adapter,
    score: adapter.detect(context.pageUrl || context.sourceUrl, context.pageTitle, context.pageText),
  })).sort((left, right) => right.score - left.score);
  if (scores[0]?.score > 0) return scores[0].adapter;
  const platform = String(context.platform || '').toLowerCase();
  return PURCHASE_PLATFORM_ADAPTERS.find((adapter) => (
    adapter.id === platform || adapter.label.toLowerCase() === platform
  )) || unknownAdapter;
}

export function normalizePurchaseCapture(context = {}) {
  const adapter = resolvePurchasePlatformAdapter(context);
  const capture = adapter.normalize(context);
  return Object.freeze({
    ...capture,
    sourceConfidence: capture.sourceConfidence || adapter.getConfidence(capture),
  });
}
