import { describe, expect, it } from 'vitest';
import { getProfitLedgerSnapshotCacheKeyCandidates } from './profitLedgerService.js';

describe('利润快照店铺变更兼容读取', () => {
  it('新增一个店铺后仍能读取加入前的多店利润快照', () => {
    const candidates = getProfitLedgerSnapshotCacheKeyCandidates([
      { id: 'shop-a', clientId: 'client-a', shopAlias: 'Ozon 1店' },
      { id: 'shop-b', clientId: 'client-b', shopAlias: 'Ozon 2店' },
      { id: 'shop-c', clientId: 'client-c', shopAlias: 'Ozon 3店' },
    ]);

    expect(candidates[0]).toBe(
      'ozon-profit-ledger-v1:ozon-shop:client:client-a|ozon-shop:client:client-b|ozon-shop:client:client-c'
    );
    expect(candidates).toContain(
      'ozon-profit-ledger-v1:ozon-shop:client:client-a|ozon-shop:client:client-b'
    );
    expect(candidates).toContain(
      'ozon-profit-ledger-v1:ozon-shop:client:client-a|ozon-shop:client:client-c'
    );
    expect(candidates).toContain(
      'ozon-profit-ledger-v1:ozon-shop:client:client-b|ozon-shop:client:client-c'
    );
  });
});
