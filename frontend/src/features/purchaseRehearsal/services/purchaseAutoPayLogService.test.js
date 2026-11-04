import { describe, expect, it, vi } from 'vitest';
import { appendPurchaseAutoPayLog, loadPurchaseAutoPayLogs } from './purchaseAutoPayLogService.js';

describe('purchase auto-pay persistent logs', () => {
  it('persists normalized payment evidence and reloads it', async () => {
    let stored = { logs: [] };
    const read = vi.fn(async () => ({ value: stored }));
    const save = vi.fn(async (_namespace, value) => { stored = value; });
    await appendPurchaseAutoPayLog({ posting: 'P-1', status: 'success', message: '  付款 成功  ', transactionNo: 'ZFB-1' }, { read, save });
    const logs = await loadPurchaseAutoPayLogs({ read });
    expect(logs[0]).toMatchObject({ posting: 'P-1', status: 'success', message: '付款 成功', transactionNo: 'ZFB-1' });
  });
});
