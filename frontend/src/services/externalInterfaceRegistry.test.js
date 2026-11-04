import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

import {
  assertExternalInterfaceAllowed,
  getExternalInterfaceAccess,
  getExternalInterfaceRegistration,
  listExternalInterfaceRegistrations,
  sanitizeExternalInterfaceLog,
} from './externalInterfaceRegistry';

const LEGACY_REAL_READ_ENDPOINTS = [
  '/v1/analytics/data',
  '/v1/description-category/attribute/values/search',
  '/v1/description-category/tree',
  '/v1/returns/rfbs/get',
  '/v2/returns/company/fbs',
  '/v2/returns/company/fbs/list',
  '/v3/products/info/attributes',
  '/v3/returns/company/fbs',
  '/v4/product/info/limit',
  '/v4/product/info/prices',
  '/v5/fbs/posting/product/exemplar/status',
];

const LEGACY_TEST_ONLY_ENDPOINTS = ['/v1/a', '/v1/b', '/v1/test'];
const APP_ENDPOINT_METHOD_OVERRIDES = new Map([
  ['/v1/actions', 'GET'],
  ['/v2/chat/file/', 'GET'],
]);

function getAppSource() {
  return readSplitAppSource();
}

describe('externalInterfaceRegistry', () => {
  it('allows registered Ozon read endpoints through the read channel', () => {
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v3/posting/fbs/list',
        access: 'read',
      })
    ).not.toThrow();
    expect(getExternalInterfaceRegistration('ozon', '/v3/posting/fbs/list')?.domain).toBe('salesOrders');
  });

  it('keeps target-mode metadata on registered read endpoints', () => {
    const entry = getExternalInterfaceRegistration('ozon', '/v3/finance/transaction/list');

    expect(entry).toMatchObject({
      access: 'read',
      domain: 'finance',
      page: 'profit/finance',
      timeScope: 'selectedRange',
      pagination: 'page',
      entityKey: 'clientId+operationId',
      retryPolicy: 'bounded',
      mergePolicy: 'non-empty-field-merge',
      logPolicy: 'redacted-summary',
    });
    expect(entry.indexFields).toContain('postingNumber');
    expect(entry.sensitiveFields).toContain('Api-Key');
  });

  it('requires target-mode metadata for every registered external interface', () => {
    const registrations = listExternalInterfaceRegistrations();

    expect(registrations.length).toBeGreaterThan(0);
    for (const entry of registrations) {
      expect(entry.provider, entry.endpoint).toMatch(/^(ozon|cross-border-bus)$/);
      expect(entry.endpoint, entry.endpoint).toMatch(/^\/(?:v\d+|erpapi)\//);
      expect(entry.access, entry.endpoint).toMatch(/^(read|write)$/);
      expect(typeof entry.allowed, entry.endpoint).toBe('boolean');
      expect(entry.domain, entry.endpoint).toBeTruthy();
      expect(entry.purpose, entry.endpoint).toBeTruthy();
      expect(entry.page, entry.endpoint).toBeTruthy();
      expect(entry.shopScope, entry.endpoint).toBeTruthy();
      expect(Number.isInteger(entry.concurrencyLimit), entry.endpoint).toBe(true);
      expect(entry.concurrencyLimit, entry.endpoint).toBeGreaterThan(0);
      expect(entry.retryPolicy, entry.endpoint).toBeTruthy();
      expect(entry.cache, entry.endpoint).toBeTruthy();
      expect(entry.cacheKey, entry.endpoint).toBeTruthy();
      expect(entry.entityKey, entry.endpoint).toBeTruthy();
      expect(entry.mergePolicy, entry.endpoint).toBeTruthy();
      expect(entry.logPolicy, entry.endpoint).toBeTruthy();
      expect(entry.sensitiveFields.length, entry.endpoint).toBeGreaterThan(0);
      expect(entry.returnFieldMapping, entry.endpoint).toBeTruthy();
    }
  });

  it('registers the finance accrual migration endpoint through the same read controls', () => {
    const entry = getExternalInterfaceRegistration('ozon', '/v1/finance/accrual/by-day');

    expect(entry).toMatchObject({
      access: 'read',
      domain: 'finance',
      page: 'profit/finance',
      timeScope: 'selectedRange',
      pagination: 'date/page',
      entityKey: 'clientId+accrualId/operationId/postingNumber',
      retryPolicy: 'bounded',
      mergePolicy: 'non-empty-field-merge',
      logPolicy: 'redacted-summary',
    });
    expect(entry.indexFields).toEqual(expect.arrayContaining(['shop', 'postingNumber', 'operationId', 'accrualDate']));
    expect(entry.sensitiveFields).toEqual(expect.arrayContaining(['Client-Id', 'Api-Key']));
  });

  it('registers real legacy project read endpoints before they are reused by Pro features', () => {
    for (const endpoint of LEGACY_REAL_READ_ENDPOINTS) {
      const entry = getExternalInterfaceRegistration('ozon', endpoint);

      expect(entry, endpoint).toBeTruthy();
      expect(entry.access, endpoint).toBe('read');
      expect(entry.retryPolicy, endpoint).toBe('bounded');
      expect(entry.mergePolicy, endpoint).toBe('non-empty-field-merge');
      expect(entry.logPolicy, endpoint).toBe('redacted-summary');
      expect(entry.sensitiveFields, endpoint).toEqual(expect.arrayContaining(['Client-Id', 'Api-Key']));
    }
  });

  it('does not promote legacy unit-test placeholder endpoints into the production registry', () => {
    for (const endpoint of LEGACY_TEST_ONLY_ENDPOINTS) {
      expect(getExternalInterfaceRegistration('ozon', endpoint), endpoint).toBeNull();
    }
  });

  it('rejects unregistered external endpoints', () => {
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v1/not-registered',
        access: 'read',
      })
    ).toThrow(/not registered/);
  });

  it('blocks write endpoints through the read channel', () => {
    expect(getExternalInterfaceAccess('ozon', '/v2/products/stocks')).toBe('write');
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v2/products/stocks',
        access: 'read',
      })
    ).toThrow(/write interface/);
  });

  it('blocks read endpoints through the write channel even when confirmed', () => {
    expect(getExternalInterfaceAccess('ozon', '/v3/posting/fbs/list')).toBe('read');
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v3/posting/fbs/list',
        access: 'write',
        confirmed: true,
      })
    ).toThrow(/read interface/);
  });

  it('keeps explicitly registered read endpoints readable even when the path contains write-like words', () => {
    expect(getExternalInterfaceAccess('ozon', '/v2/posting/fbs/cancel-reason/list')).toBe('read');
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v2/posting/fbs/cancel-reason/list',
        access: 'read',
      })
    ).not.toThrow();
  });

  it('requires explicit confirmation for write endpoints', () => {
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'cross-border-bus',
        endpoint: '/erpapi/order/createOrder',
        access: 'write',
      })
    ).toThrow(/confirmed=true/);

    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'cross-border-bus',
        endpoint: '/erpapi/order/createOrder',
        access: 'write',
        confirmed: true,
      })
    ).not.toThrow();
  });

  it('enforces channel and confirmation rules for every registered interface', () => {
    for (const entry of listExternalInterfaceRegistrations()) {
      if (entry.access === 'write') {
        expect(
          () =>
            assertExternalInterfaceAllowed({
              provider: entry.provider,
              endpoint: entry.endpoint,
              method: entry.method,
              access: 'write',
            }),
          entry.endpoint
        ).toThrow(/confirmed=true/);
        expect(() =>
          assertExternalInterfaceAllowed({
            provider: entry.provider,
            endpoint: entry.endpoint,
            method: entry.method,
            access: 'write',
            confirmed: true,
          })
        ).not.toThrow();
        expect(() =>
          assertExternalInterfaceAllowed({
            provider: entry.provider,
            endpoint: entry.endpoint,
            method: entry.method,
            access: 'read',
          })
        ).toThrow(/write interface/);
        continue;
      }

      expect(() =>
        assertExternalInterfaceAllowed({
          provider: entry.provider,
          endpoint: entry.endpoint,
          method: entry.method,
          access: 'read',
        })
      ).not.toThrow();
      expect(() =>
        assertExternalInterfaceAllowed({
          provider: entry.provider,
          endpoint: entry.endpoint,
          method: entry.method,
          access: 'write',
          confirmed: true,
        })
      ).toThrow(/read interface/);
    }
  });

  it('registers cross-border setup endpoints as readable and order mutations as writes', () => {
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/token/index')).toBe('read');
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/storehouse/cooperationStorehouse')).toBe('read');
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/user/queryauthorization')).toBe('read');
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/user/authorization')).toBe('write');
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/user/unauthorization')).toBe('write');
    expect(getExternalInterfaceAccess('cross-border-bus', '/erpapi/order/createOrder')).toBe('write');
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'cross-border-bus',
        endpoint: '/erpapi/user/authorization',
        access: 'read',
      })
    ).toThrow(/write interface/);
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'cross-border-bus',
        endpoint: '/erpapi/user/authorization',
        access: 'write',
      })
    ).toThrow(/confirmed=true/);
  });

  it('registers marketing actions with the method used by the app', () => {
    expect(() =>
      assertExternalInterfaceAllowed({
        provider: 'ozon',
        endpoint: '/v1/actions',
        method: 'GET',
        access: 'read',
      })
    ).not.toThrow();
    expect(getExternalInterfaceRegistration('ozon', '/v1/actions', 'GET')?.domain).toBe('marketing');
    expect(getExternalInterfaceRegistration('ozon', '/v1/actions')).toBeNull();
  });

  it('redacts sensitive log fields recursively', () => {
    const uuidSecret = '11111111-2222-3333-4444-555555555555';
    expect(
      sanitizeExternalInterfaceLog({
        apiKey: 'secret',
        message: `token=${uuidSecret}`,
        nested: {
          clientSecret: 'hidden',
          raw: `request failed with ${uuidSecret}`,
          rows: 3,
        },
      })
    ).toEqual({
      apiKey: '[REDACTED]',
      message: '[REDACTED]',
      nested: {
        clientSecret: '[REDACTED]',
        raw: 'request failed with [REDACTED]',
        rows: 3,
      },
    });
  });

  it('keeps Ozon and cross-border remote calls behind local-api instead of frontend fetches', () => {
    const appSource = getAppSource();
    const ozonFetches = [...appSource.matchAll(/fetch\(\s*`\$\{OZON_SELLER_API_BASE\}/g)].map((match) => match.index);
    const crossBorderFetches = [...appSource.matchAll(/fetch\(\s*`\$\{CROSS_BORDER_API_BASE\}/g)].map(
      (match) => match.index
    );

    const ozonGatewayStart = appSource.indexOf('async function requestOzonSellerApi');
    const crossBorderReadOnlyStart = appSource.indexOf('async function requestCrossBorderReadOnly');

    expect(ozonFetches).toHaveLength(0);
    expect(crossBorderFetches).toHaveLength(0);
    expect(ozonGatewayStart).toBeGreaterThanOrEqual(0);
    expect(crossBorderReadOnlyStart).toBeGreaterThanOrEqual(0);
    expect(appSource).toContain('requestLocalOzon(');
    expect(appSource).toContain('readCrossBorderEndpoint({');
    expect(appSource).not.toContain('async function requestCrossBorderApi');
    expect(appSource).not.toContain('CROSS_BORDER_DIRECT_API_DEPRECATED');

    expect(appSource.match(/requestOzonSellerApi\(/g)).toHaveLength(3);
    expect(appSource.match(/requestOzonReadOnly[\s\S]*?assertExternalInterfaceAllowed/)).toBeTruthy();
    expect(appSource.match(/requestOzonWrite[\s\S]*?assertExternalInterfaceAllowed/)).toBeTruthy();
    expect(appSource.match(/requestCrossBorderReadOnly[\s\S]*?assertExternalInterfaceAllowed/)).toBeTruthy();
  });

  it('does not add literal direct Ozon or cross-border fetch endpoints outside the gateways', () => {
    const appSource = getAppSource();
    const directExternalFetchPatterns = [
      /fetch\(\s*['"`]https:\/\/api-seller\.ozon/gi,
      /fetch\(\s*['"`]https:\/\/seller\.ozon/gi,
      /fetch\(\s*['"`]https?:\/\/[^'"`)]*cross[-_]?border/gi,
      /fetch\(\s*['"`]https?:\/\/[^'"`)]*guoo/gi,
    ];

    directExternalFetchPatterns.forEach((pattern) => {
      expect(appSource.match(pattern) ?? []).toHaveLength(0);
    });
  });

  it('forwards cross-border read cancellation and dedupe options into the controlled queue', () => {
    const appSource = getAppSource();
    const readOnlyStart = appSource.indexOf('async function requestCrossBorderReadOnly');
    const readOnlyEnd = appSource.indexOf('function canUseCrossBorderOrderWrite', readOnlyStart);
    const readOnlySource = appSource.slice(readOnlyStart, readOnlyEnd);

    expect(readOnlySource).toContain('timeoutMs: options.timeoutMs');
    expect(readOnlySource).toContain('signal: options.signal');
    expect(readOnlySource).toContain('dedupeKey: options.dedupeKey');
    expect(readOnlySource).toContain('maxRetries: options.maxRetries');
    expect(readOnlySource).toContain('readCrossBorderEndpoint({');
    expect(readOnlySource).not.toContain('fetch(');
  });

  it('keeps Ozon write operations confirmed, non-retry, and non-deduped', () => {
    const appSource = getAppSource();
    const writeStart = appSource.indexOf('async function requestOzonWrite');
    const writeEnd = appSource.indexOf('function isOzonRetryableReadError', writeStart);
    const writeSource = appSource.slice(writeStart, writeEnd);

    expect(writeSource).toContain('confirmed: options.confirmed === true');
    expect(writeSource).toContain('maxRetries: options.maxRetries ?? 0');
    expect(writeSource).toContain('dedupeKey: false');
  });

  it('registers every literal Ozon and cross-border endpoint used by App', () => {
    const appSource = getAppSource();
    const endpoints = [
      ...new Set([...appSource.matchAll(/['"]((?:\/v\d+|\/erpapi)\/[^'"]+)['"]/g)].map((match) => match[1])),
    ];

    const missing = endpoints.filter((endpoint) => {
      const provider = endpoint.startsWith('/erpapi/') ? 'cross-border-bus' : 'ozon';
      const method = APP_ENDPOINT_METHOD_OVERRIDES.get(endpoint) || 'POST';
      return !getExternalInterfaceRegistration(provider, endpoint, method);
    });

    expect(missing).toEqual([]);
  });
});
