import { searchOzonProductCaptureData } from '../ozonMarketCapture/marketCaptureWorkflow.js';
import {
  isActiveOzonProductQueryMode,
  resolveOzonSearchQueryPlan,
} from './ozonSearchQueryResolver.js';

export async function searchOzonProductsFromInput(values = {}, options = {}) {
  const queryMode = options.queryMode || 'product';
  if (!isActiveOzonProductQueryMode(queryMode)) {
    return { queryPlan: null, snapshot: null };
  }
  const queryPlan = await resolveOzonSearchQueryPlan(values, {
    queryMode,
    categoryTreeLoader: options.categoryTreeLoader,
    loadCategoryCatalog: options.loadCategoryCatalog,
    timeoutMs: options.catalogTimeoutMs,
    signal: options.signal,
  });
  if (!queryPlan.query) return { queryPlan, snapshot: null };

  const searchExecutor = options.searchExecutor || searchOzonProductCaptureData;
  const snapshot = await searchExecutor(queryPlan.query, {
    ...(options.captureOptions || {}),
    productSearchAlternatives: queryPlan.aliases,
    productPerformanceCategoryIds: queryPlan.categoryIds,
    productPerformancePreferCategoryOnly:
      options.captureOptions?.productPerformancePreferCategoryOnly
      ?? queryPlan.categoryIds.length > 0,
  });
  return { queryPlan, snapshot };
}
