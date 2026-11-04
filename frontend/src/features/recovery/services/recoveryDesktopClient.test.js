import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateStagedRecovery,
  backupShopRecovery,
  getRecoveryStatus,
  listRecoveryGenerations,
  reloadDesktopAfterRestore,
  stageRecoveryGeneration,
} from './recoveryDesktopClient.js';

afterEach(() => {
  delete window.wangzaiDesktop;
});

describe('recoveryDesktopClient', () => {
  it('uses only the desktop recovery bridge and never asks the renderer for a remote token', async () => {
    const recoveryRequest = vi.fn(async (input) => ({
      ok: true,
      status: 200,
      data: input.command === 'list-generations'
        ? { generations: [{ generation_id: 'g1' }] }
        : input.command === 'status'
          ? { enrolled: true }
          : input.command === 'stage-restore'
            ? { restoreId: 'r1' }
          : { ok: true, remoteGenerationId: 'g1' },
    }));
    window.wangzaiDesktop = { recoveryRequest };
    await expect(backupShopRecovery({ shopId: 'shop-a', passphrase: 'portable recovery passphrase' }))
      .resolves.toMatchObject({ remoteGenerationId: 'g1' });
    await expect(listRecoveryGenerations()).resolves.toEqual([{ generation_id: 'g1' }]);
    await expect(getRecoveryStatus()).resolves.toEqual({ enrolled: true });
    await expect(stageRecoveryGeneration({ generationId: 'g1', passphrase: 'portable recovery passphrase' }))
      .resolves.toEqual({ restoreId: 'r1' });
    await expect(activateStagedRecovery({ restoreId: 'r1' })).resolves.toMatchObject({ remoteGenerationId: 'g1' });
    await expect(reloadDesktopAfterRestore()).resolves.toBeUndefined();
    expect(recoveryRequest).toHaveBeenNthCalledWith(1, {
      command: 'backup-shop', shopId: 'shop-a', passphrase: 'portable recovery passphrase',
    });
    expect(JSON.stringify(recoveryRequest.mock.calls)).not.toContain('accessToken');
  });

  it('fails closed outside the desktop bridge', async () => {
    await expect(listRecoveryGenerations()).rejects.toMatchObject({ code: 'RECOVERY_DESKTOP_BRIDGE_REQUIRED' });
  });
});
