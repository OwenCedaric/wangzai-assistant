import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const BILLABLE_ENDPOINT = /\/(?:chat\/completions|images\/(?:generations|edits)|open-api\/(?:shop\/detail\/search|product\/detail\/search|category\/detail\/search|productReport\/search|market\/search|keyword\/mining|keyword\/backSearch)\/ozon)/u;

const EXPECTED_ENDPOINT_OWNERS = Object.freeze([
  'desktop/src/runtime/wechatAssistantModelExecutor.js',
  'desktop/src/runtime/wechatAssistantModelRelay.js',
  'local-api/src/domain/dataAnalysis/dataAnalysisInsightService.js',
  'local-api/src/domain/externalDataInsights/externalDataInsightService.js',
  'local-api/src/domain/imagePromptPlans/imagePromptPlanService.js',
  'local-api/src/domain/productDescriptions/productDescriptionService.js',
  'local-api/src/domain/productImages/productImageAssetService.js',
  'local-api/src/integrations/externalDataApiClient.js',
]);

const GATED_MODEL_SERVICES = Object.freeze([
  'local-api/src/domain/dataAnalysis/dataAnalysisInsightService.js',
  'local-api/src/domain/externalDataInsights/externalDataInsightService.js',
  'local-api/src/domain/imagePromptPlans/imagePromptPlanService.js',
  'local-api/src/domain/productDescriptions/productDescriptionService.js',
]);

function sourceFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolute));
    else if (/\.(?:c?js|jsx|mjs)$/u.test(entry.name) && !/\.test\.[^.]+$/u.test(entry.name)) {
      result.push(absolute);
    }
  }
  return result;
}

function relative(file) {
  return path.relative(workspaceRoot, file).replaceAll('\\', '/');
}

function source(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

test('every known billable endpoint remains inside an explicitly gated owner', () => {
  const roots = ['local-api/src', 'frontend/src', 'desktop/src'];
  const owners = roots
    .flatMap((root) => sourceFiles(path.join(workspaceRoot, root)))
    .filter((file) => BILLABLE_ENDPOINT.test(readFileSync(file, 'utf8')))
    .map(relative)
    .sort();
  assert.deepEqual(owners, [...EXPECTED_ENDPOINT_OWNERS].sort());

  for (const file of GATED_MODEL_SERVICES) {
    const body = source(file);
    assert.match(body, /paidCapabilityAccess\.execute\(/u, `${file} must retain paid fallback`);
    assert.match(body, /isVerifiedModelApiAccount\(/u, `${file} must verify BYOK before direct use`);
  }
  const imageService = source('local-api/src/domain/productImages/productImageAssetService.js');
  assert.doesNotMatch(imageService, /paidCapabilityAccess\.execute\(/u);
  assert.match(imageService, /account\?\.discoveryVerified !== true/u);
  assert.match(imageService, /isApprovedImageProvider\(account, candidate\.model\)/u);
  assert.match(imageService, /APPROVED_IMAGE_MODEL_ID/u);

  const paidClient = source('local-api/src/domain/paidCapabilities/paidCapabilityClient.js');
  assert.match(paidClient, /endpoint\(baseUrl, '\/api\/points\/wallet'\)/u);
  assert.match(paidClient, /availablePoints < quote\.maximumPoints/u);
  assert.match(paidClient, /POINT_BALANCE_INSUFFICIENT/u);

  const desktopProxy = source('desktop/src/runtime/localApiProxy.js');
  assert.match(desktopProxy, /createPaidCapabilityPointsReader/u);
  assert.match(desktopProxy, /verifyBuiltinPoints\(\)/u);
  assert.match(desktopProxy, /APPROVED_IMAGE_API_BASE_URL/u);
  assert.match(desktopProxy, /APPROVED_IMAGE_MODEL_ID/u);
  assert.match(desktopProxy, /isApprovedImageProvider\(baseUrlValue, model\)/u);
  assert.match(desktopProxy, /\/api\/core-v2\/image-model\/execute/u);

  const openClawExecutor = source('desktop/src/runtime/wechatAssistantModelExecutor.js');
  assert.match(openClawExecutor, /assertWechatAssistantPointsAvailable\(await getPointsWallet\(\)\)/u);
});

test('Seerfar paid reads and desktop token injection stay on exact reusable boundaries', () => {
  // The /api/integrations routes live in integrationAccountRoute.js; createApp must
  // still wire that module with the shared paid-capability gate.
  const app = source('local-api/src/app/createApp.js');
  assert.match(app, /createIntegrationAccountRoute\(\{[^}]*\bpaidCapabilityAccess,/u);
  assert.match(app, /if \(handleIntegrationAccountRoute\(\{/u);
  const integrationRoute = source('local-api/src/app/integrationAccountRoute.js');
  assert.match(integrationRoute, /preparePaidSeerfarRead\(body\)/u);
  assert.match(integrationRoute, /paidCapabilityAccess\.execute\(\{/u);
  assert.match(integrationRoute, /credentials\.lastTestStatus === ["']connected["']/u);
  assert.match(integrationRoute, /Date\.now\(\) - testedAt <= 10 \* 60 \* 1000/u);

  const proxy = source('desktop/src/runtime/localApiProxy.js');
  for (const route of [
    '/api/product-descriptions/generate',
    '/api/image-prompt-plans/generate',
    '/api/data-analysis/insights',
    '/api/integrations/analyze',
    '/api/integrations/read',
    '/api/product-images/generate',
    '/api/product-images/edit',
  ]) {
    assert.match(proxy, new RegExp(`"${route.replaceAll('/', '\\/')}"`, 'u'));
  }
  assert.match(proxy, /ALLOWED_HEADERS = new Set\(\[/u);
  assert.doesNotMatch(
    proxy.slice(proxy.indexOf('const ALLOWED_HEADERS'), proxy.indexOf(']);', proxy.indexOf('const ALLOWED_HEADERS'))),
    /paid-capability-access-token/u,
  );
  assert.match(proxy, /"x-wangzai-paid-capability-access-token": accessToken/u);
});
