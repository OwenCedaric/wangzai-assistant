import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../../test/appSource.js';

const executionModelSource = readProjectSource(
  'src/features/promptLibrary/model/usePromptLibraryExecution.js',
);
const browserDataServiceSource = readProjectSource(
  'src/features/promptLibrary/services/smartToolOzonBrowserDataService.js',
);
const browserProfilesSource = readProjectSource(
  'src/features/promptLibrary/lib/smartToolOzonBrowserDataProfiles.js',
);
const productSearchServiceSource = readProjectSource(
  'src/services/ozonSearch/ozonProductSearchService.js',
);
const queryResolverSource = readProjectSource(
  'src/services/ozonSearch/ozonSearchQueryResolver.js',
);
const marketWorkflowSource = readProjectSource(
  'src/services/ozonMarketCapture/marketCaptureWorkflow.js',
);
const followSellerCaptureSource = readProjectSource(
  'src/services/ozonMarketCapture/followSellerCaptureService.js',
);
const standardRunSource = readProjectSource(
  'src/features/promptLibrary/components/PromptLibraryStandardRun.jsx',
);
const productResultSource = readProjectSource(
  'src/features/promptLibrary/components/PromptLibraryOzonProductResult.jsx',
);
const productAnalysisSource = readProjectSource(
  'src/features/promptLibrary/lib/smartToolOzonProductAnalysis.js',
);
const productDecisionRulesSource = readProjectSource(
  'src/features/promptLibrary/lib/smartToolOzonProductDecisionRules.js',
);
const skillCatalogSource = readProjectSource(
  'src/features/promptLibrary/lib/smartToolSkillCatalog.js',
);

function listRuntimeSources(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return listRuntimeSources(path);
    if (!/\.[jt]sx?$/u.test(entry) || /\.test\.[jt]sx?$/u.test(entry)) return [];
    return [readFileSync(path, 'utf8')];
  });
}

describe('Ozon product search canonical path', () => {
  it('locks the Skill to the shared resolver, product search service and product-performance capture path', () => {
    expect(executionModelSource).toContain("from '../services/smartToolOzonBrowserDataService.js'");
    expect(browserDataServiceSource).toContain("from '../../../services/ozonSearch/ozonProductSearchService.js'");
    expect(browserDataServiceSource).toContain("from '../../../services/ozonSearch/ozonSearchQueryResolver.js'");
    expect(browserProfilesSource).toContain('isActiveOzonProductQueryMode');
    expect(productSearchServiceSource).toContain("from '../ozonMarketCapture/marketCaptureWorkflow.js'");
    expect(productSearchServiceSource).toContain("from './ozonSearchQueryResolver.js'");
    expect(marketWorkflowSource).toContain("getOzonProductPerformanceRoute");
    expect(marketWorkflowSource).toContain("/api/site/seller-analytics/what_to_sell/data/v3");
    expect(queryResolverSource).toContain('resolveOzonSearchQueryPlan');
  });

  it('keeps retired query facades and legacy product-search fallbacks out of the runtime', () => {
    expect(existsSync(join(
      process.cwd(),
      'src/features/promptLibrary/lib/smartToolOzonQueryNormalizer.js',
    ))).toBe(false);
    expect(browserDataServiceSource).not.toContain('smartToolOzonQueryNormalizer');
    expect(browserProfilesSource).not.toContain('ACTIVE_PRODUCT_QUERY_MODES');
    expect(productSearchServiceSource).not.toContain('allowLegacyProductSearchFallback');
    expect(productSearchServiceSource).not.toContain('productSearchCategoryIds');
    expect(productSearchServiceSource).not.toContain('productSearchCategoryHints');
    expect(marketWorkflowSource).not.toContain('allowLegacyProductSearchFallback');
    expect(marketWorkflowSource).not.toContain('createProductSearchProbe');
    expect(marketWorkflowSource).not.toContain('latestMissingItemsRecipe');
  });

  it('keeps optional logistics outside the verified product-search completion gate', () => {
    expect(followSellerCaptureSource).toMatch(
      /function isCompleteCapture\(result = \{\}\) \{[\s\S]*return isFollowSellerConfirmed\(result\)[\s\S]*&& isProductFactsConfirmed\(result\);[\s\S]*\}/u,
    );
    expect(followSellerCaptureSource).not.toMatch(
      /function isCompleteCapture\(result = \{\}\) \{[\s\S]*&& isProductLogisticsConfirmed\(result\);[\s\S]*\}/u,
    );
    expect(followSellerCaptureSource).not.toContain("'ozon-seller-variant'");
  });

  it('locks successful product output to the structured result component and shared workbench action', () => {
    expect(standardRunSource).toContain('PromptLibraryOzonProductResult');
    expect(standardRunSource).toContain('hasOzonProductAnalysis');
    expect(productResultSource).toContain('onOpenProduct');
    expect(productResultSource).toContain('prompt-library-ozon-summary-grid');
    expect(productResultSource).toContain('prompt-library-ozon-table-wrap');
  });

  it('locks decision analysis to the versioned rule layer instead of UI calculations', () => {
    expect(productAnalysisSource).toContain("from './smartToolOzonProductDecisionRules.js'");
    expect(productDecisionRulesSource).toContain("OZON_PRODUCT_DECISION_RULES_VERSION = 'ozon-product-decision-v1'");
    expect(productDecisionRulesSource).toContain('evaluateOzonProductDecision');
    expect(productDecisionRulesSource).not.toMatch(/\bfetch\s*\(/u);
    expect(skillCatalogSource).toContain('analysisRulesVersion: OZON_PRODUCT_DECISION_RULES_VERSION');
    expect(productResultSource).toContain('OzonProductDecisionPanel');
    expect(productResultSource).toContain('opportunity.breakdown');
  });

  it('keeps build-time Skill source archives outside the frontend runtime graph', () => {
    const runtimeSource = listRuntimeSources(join(process.cwd(), 'src')).join('\n');
    expect(runtimeSource).not.toContain('skill-sources/');
    expect(runtimeSource).not.toContain('skill-sources\\');
  });
});
