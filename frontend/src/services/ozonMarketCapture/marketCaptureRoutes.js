export const OZON_MARKET_CAPTURE_ROUTES = Object.freeze([
  {
    id: 'all-queries',
    url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries',
    datasets: ['keywords'],
    preferProbe: true,
    paginationMode: 'complete',
    probes: [{
      path: '/api/site/searchteam/Stats/queries/search/v2',
      method: 'POST',
      origin: 'https://seller.ozon.ru',
      body: { text: '', limit: '50', offset: '0', period: 'days_7' },
    }],
    timeoutMs: 10_000,
    settleMs: 1_500,
  },
  {
    id: 'ozon-bestsellers',
    url: 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers',
    datasets: ['product-performance'],
    // The page's natural request shape can drift and occasionally omits an
    // explicit page field.  Use the audited read-only probe body below as the
    // pagination recipe instead of guessing from that drifting request.
    preferProbe: true,
    paginationMode: 'complete',
    timeoutMs: 10_000,
    settleMs: 3_000,
    probes: [{
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      method: 'POST',
      origin: 'https://api.seller.ozon.ru',
      body: { limit: 50, offset: 0, filter: { period: 'monthly', categories: [] } },
    }],
  },
  {
    id: 'market-bestsellers',
    url: 'https://seller.ozon.ru/app/analytics/what-to-sell/market-bestsellers',
    datasets: ['market-products', 'products', 'missing-items'],
    preferProbe: true,
    // The audited request contains a real offset/limit recipe. Replay it in
    // bounded batches until Ozon reports the end; interrupted reads still keep
    // the previous trusted cache and therefore cannot shrink the visible data.
    paginationMode: 'complete',
    probes: [{
      path: '/api/site/exa-products-api/missing_items',
      method: 'POST',
      // The seller bundle builds a camelCase view model, but its HTTP client
      // serializes the actual network body to snake_case. The live endpoint
      // returns rows for this wire schema and an empty 200 response for the
      // untransformed camelCase object.
      origin: 'https://seller.ozon.ru',
      body: {
        filter: {
          product_name: '',
          category_ids: [],
          brand_ids: [],
          price_segment: {},
        },
        limit: '10',
        offset: '0',
        sort: { metric: 'metric_gmv_sum', direction: 'direction_desc' },
      },
    }],
  },
  {
    id: 'all-bestsellers',
    url: 'https://seller.ozon.ru/app/analytics/what-to-sell/all-bestsellers',
    datasets: ['market-products', 'products', 'missing-items'],
    // This page returns snapshot responses without an offset/cursor contract.
    // Replaying the observed request only returns the same page again, so it
    // must be handled like the graphs snapshot instead of reporting a false
    // duplicate-page pagination failure on every refresh.
    pagination: false,
  },
  {
    id: 'graphs',
    url: 'https://seller.ozon.ru/app/analytics/graphs',
    datasets: ['traffic-conversion', 'trends', 'products', 'reports'],
    // Graph responses are complete time-series snapshots. They have no remote
    // list cursor, so replaying them as pages only creates a false failure.
    pagination: false,
  },
]);

export const OZON_MARKET_PAGINATION_POLICIES = Object.freeze({
  keywords: Object.freeze({ maxPages: 250, batchPages: 5 }),
  'product-performance': Object.freeze({ maxPages: 100, batchPages: 5 }),
  products: Object.freeze({ maxPages: 250, batchPages: 5 }),
  'market-products': Object.freeze({ maxPages: 250, batchPages: 5 }),
  'missing-items': Object.freeze({ maxPages: 250, batchPages: 5 }),
  comparison: Object.freeze({ maxPages: 150, batchPages: 5 }),
  categories: Object.freeze({ maxPages: 150, batchPages: 5 }),
  brands: Object.freeze({ maxPages: 150, batchPages: 5 }),
  'price-segments': Object.freeze({ maxPages: 100, batchPages: 5 }),
  trends: Object.freeze({ maxPages: 100, batchPages: 5 }),
  'traffic-conversion': Object.freeze({ maxPages: 100, batchPages: 5 }),
});

// A full keyword + product + missing-item pass can legitimately span several
// hundred read-only pages.  Use small native batches so one slow response does
// not discard twenty already requested pages, while the shared deadline is
// long enough to finish a complete accuracy-first pass on a slow connection.
export const OZON_MARKET_REFRESH_BUDGET_MS = 20 * 60_000;
export const OZON_MARKET_COMMAND_RESERVE_MS = 30_000;

export function getDefaultOzonMarketRoute() {
  return OZON_MARKET_CAPTURE_ROUTES.find((route) => route.id === 'market-bestsellers')
    || OZON_MARKET_CAPTURE_ROUTES[0];
}

export function getOzonMarketSearchRoute() {
  return OZON_MARKET_CAPTURE_ROUTES.find((route) => route.id === 'all-queries')
    || OZON_MARKET_CAPTURE_ROUTES[0];
}

export function getOzonProductPerformanceRoute() {
  return OZON_MARKET_CAPTURE_ROUTES.find((route) => route.id === 'ozon-bestsellers')
    || OZON_MARKET_CAPTURE_ROUTES[0];
}
