import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('collection pricing protected-compute boundary', () => {
  it('keeps Page declarative and routes Model through the feature service', () => {
    const page = source('./CollectionPricingPage.jsx');
    const model = source('./model/useCollectionProductPricing.js');
    const service = source('./services/collectionPricingQuoteService.js');
    expect(page).not.toMatch(/fetch\s*\(|protectedComputeClient|requestCollectionPricingQuote/u);
    expect(model).toContain("from '../services/collectionPricingQuoteService.js'");
    expect(model).not.toMatch(/fetch\s*\(|protectedComputeClient|executeCollectionPricingQuote/u);
    expect(service).toContain("from '../../../services/protectedComputeClient.js'");
    expect(service).toContain('executeCollectionPricingQuote');
  });

  it('does not calculate or auto-request a quote in Renderer code', () => {
    const calculator = source('./lib/pricingCalculator.js');
    const model = source('./model/useCollectionProductPricing.js');
    expect(calculator).not.toMatch(
      /denominator|feeRate|currentFee|totalCost\s*=\s*purchaseCost|\/\s*\(1\s*-|PROTECTED_CORE_ONLY|_POLICY_/u
    );
    expect(calculator).not.toContain('buildPricingPreview');
    expect(model.match(/requestCollectionPricingQuote\s*\(/gu) || []).toHaveLength(1);
    expect(model).toContain('const requestQuote = React.useCallback(async () =>');
  });
});
