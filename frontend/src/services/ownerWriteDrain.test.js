import { describe, expect, it } from 'vitest';
import { settleOwnerWriteDrain } from './ownerWriteDrain.js';

describe('owner write drain settlement semantics', () => {
  it('waits for every pending write while preserving an already-failed caller promise', async () => {
    const reason = new Error('synthetic historical write failure');
    const failed = Promise.reject(reason);
    void failed.catch(() => undefined);
    let finish;
    const pendingOtherOwner = new Promise(resolve => { finish = resolve; });
    let drained = false;
    const observation = settleOwnerWriteDrain([failed, pendingOtherOwner]).then(result => { drained = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false);
    finish({ saved: true });
    expect(await observation).toEqual({ drained: true, lastWriteFailed: true, failedWrites: 1 });
    await expect(failed).rejects.toBe(reason);
  });
  it('does not count one failed promise twice and reports a successful empty drain without save claims', async () => {
    const failed = Promise.reject(new Error('synthetic'));
    void failed.catch(() => undefined);
    expect((await settleOwnerWriteDrain([failed, failed])).failedWrites).toBe(1);
    expect(await settleOwnerWriteDrain([])).toEqual({ drained: true, failedWrites: 0, lastWriteFailed: false });
  });
});
