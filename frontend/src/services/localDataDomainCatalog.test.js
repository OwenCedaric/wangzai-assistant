import { describe, expect, it } from 'vitest';
import {
  buildReusableEntityKey,
  findLocalDataDomain,
  getDomainsByEntityType,
  getLocalDataDomainCatalog,
  getLocalDataDomainDirectory,
  getReusableEntityOwner,
  LOCAL_DATA_DOMAIN_CATALOG_VERSION,
} from './localDataDomainCatalog.js';

describe('localDataDomainCatalog', () => {
  it('exposes a stable catalog with core business domains', () => {
    const catalog = getLocalDataDomainCatalog();
    const ids = catalog.map((domain) => domain.id);

    expect(LOCAL_DATA_DOMAIN_CATALOG_VERSION).toBe('local-data-domain-catalog-v1');
    expect(ids).toContain('products');
    expect(ids).toContain('productImages');
    expect(ids).toContain('salesOrders');
    expect(ids).toContain('purchase');
    expect(ids).toContain('afterSales');
    expect(ids).toContain('profit');
    expect(ids).toContain('finance');
  });

  it('keeps reusable entity ownership centralized', () => {
    expect(getReusableEntityOwner('product')?.id).toBe('products');
    expect(getReusableEntityOwner('productImage')?.id).toBe('productImages');
    expect(getReusableEntityOwner('salesOrder')?.id).toBe('salesOrders');
    expect(getReusableEntityOwner('profitLedger')?.id).toBe('profit');
  });

  it('returns domain directories without touching runtime data', () => {
    expect(findLocalDataDomain('profit')?.label).toBe('Profit ledger');
    expect(getLocalDataDomainDirectory('productImages')).toBe('分类缓存/04-商品图片');
    expect(getLocalDataDomainDirectory('missing-domain')).toBe('');
  });

  it('finds domains by owned entity type', () => {
    expect(getDomainsByEntityType('financeTransaction').map((domain) => domain.id)).toEqual(['finance']);
    expect(getDomainsByEntityType('retryTask').map((domain) => domain.id)).toEqual(['retry']);
    expect(getDomainsByEntityType('readDiagnostic').map((domain) => domain.id)).toEqual(['retry']);
    expect(getDomainsByEntityType('unknown')).toEqual([]);
  });

  it('builds stable reusable entity keys for cross-page references', () => {
    expect(buildReusableEntityKey('productImage', { url: 'https://img.example.test/a.jpg' })).toBe(
      'image-url:https://img.example.test/a.jpg'
    );
    expect(buildReusableEntityKey('product', { clientId: 'client-a', offerId: 'mz-26050813-905658' })).toBe(
      'product:client-client-a:mz-26050813-905658'
    );
    expect(buildReusableEntityKey('salesOrder', { clientId: 'client-a', postingNumber: '0123640791-0163-1' })).toBe(
      'sales-order:client-client-a:0123640791-0163-1'
    );
    expect(buildReusableEntityKey('crossBorderBusOrder', { clientId: 'client-a', busOrderId: '49531424' })).toBe(
      'bus-order:client-client-a:49531424'
    );
    expect(buildReusableEntityKey('profitLedger', { clientId: 'client-a', postingNumber: '0123640791-0163-1' })).toBe(
      'profit-ledger:client-client-a:0123640791-0163-1'
    );
  });
});
