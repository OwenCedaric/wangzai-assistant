import { describe, expect, it } from 'vitest';
import {
  getAfterSalesCanonicalEntityKey,
  getAfterSalesPostingBaseKey,
  getAfterSalesReturnIdentity,
} from './afterSalesIdentity.js';

describe('afterSalesIdentity', () => {
  it('uses each explicit after-sales id as an independent entity', () => {
    const first = {
      clientId: '4616153',
      returnId: '84360443',
      salesOrder: '44487710-0160-1',
    };
    const second = {
      clientId: '4616153',
      returnId: '84360444',
      salesOrder: '44487710-0160-1',
    };

    expect(getAfterSalesCanonicalEntityKey(first)).toBe('4616153:return:84360443');
    expect(getAfterSalesCanonicalEntityKey(second)).toBe('4616153:return:84360444');
  });

  it('keeps the child suffix when a cancelled fallback has no after-sales id', () => {
    const first = {
      source: 'order-cancelled',
      clientId: '4616153',
      id: '67006620-0050',
      salesOrder: '67006620-0050-1',
    };
    const second = {
      source: 'order-cancelled',
      clientId: '4616153',
      id: '67006620-0050',
      salesOrder: '67006620-0050-2',
    };

    expect(getAfterSalesReturnIdentity(first)).toBe('');
    expect(getAfterSalesReturnIdentity(second)).toBe('');
    expect(getAfterSalesCanonicalEntityKey(first)).toBe('4616153:order:67006620-0050-1');
    expect(getAfterSalesCanonicalEntityKey(second)).toBe('4616153:order:67006620-0050-2');
  });

  it('uses the mother posting only as a lookup relation', () => {
    expect(getAfterSalesPostingBaseKey('09362844-0405-1')).toBe('09362844-0405');
    expect(getAfterSalesPostingBaseKey('09362844-0405-2')).toBe('09362844-0405');
  });
});
