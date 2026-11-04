import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestLocalApi } from '../../../api/localApiClient.js';
import {
  confirmProfileDomainRebuild,
  confirmProfileSpaceRelease,
  getProfileMaintenanceContracts,
  prepareProfileDomainRebuildTicket,
  previewProfileDomainRebuild,
  previewProfileSpaceRelease,
} from './profileMaintenanceClient.js';

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: vi.fn(async (_path, options) => ({ ok: true, body: options?.body })),
}));

describe('profileMaintenanceClient', () => {
  beforeEach(() => requestLocalApi.mockClear());

  it('owns the typed contracts and preview routes', async () => {
    await getProfileMaintenanceContracts({ signal: 'unit-signal' });
    await previewProfileSpaceRelease();
    await previewProfileDomainRebuild('exchange-rate-cache');

    expect(requestLocalApi).toHaveBeenNthCalledWith(
      1,
      '/api/app/profile-maintenance/contracts',
      { signal: 'unit-signal', method: 'GET' },
    );
    expect(requestLocalApi).toHaveBeenNthCalledWith(
      2,
      '/api/app/profile-maintenance/preview',
      { method: 'POST', body: { command: 'release-space' } },
    );
    expect(requestLocalApi).toHaveBeenNthCalledWith(
      3,
      '/api/app/profile-maintenance/preview',
      { method: 'POST', body: { command: 'rebuild-domain', domain: 'exchange-rate-cache' } },
    );
  });

  it('does not transmit a confirmation token until the UI records explicit human confirmation', async () => {
    expect(() => confirmProfileSpaceRelease({
      humanConfirmationToken: 'preview-unit',
      humanConfirmed: false,
    })).toThrow('PROFILE_MAINTENANCE_HUMAN_CONFIRMATION_REQUIRED');
    expect(requestLocalApi).not.toHaveBeenCalled();

    await confirmProfileSpaceRelease({
      humanConfirmationToken: 'preview-unit',
      humanConfirmed: true,
    });
    expect(requestLocalApi).toHaveBeenCalledWith(
      '/api/app/profile-maintenance/confirm',
      {
        method: 'POST',
        body: {
          command: 'release-space',
          confirmation: 'RELEASE_RETIRED_PROFILE_SPACE_ONLY',
          humanConfirmationToken: 'preview-unit',
        },
      },
    );
  });

  it('passes one explicit rebuild domain only with an opaque local-api trusted-source ticket', async () => {
    await prepareProfileDomainRebuildTicket({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: 'preview-rebuild',
    });
    expect(requestLocalApi).toHaveBeenCalledWith(
      '/api/app/profile-maintenance/prepare-ticket',
      {
        method: 'POST',
        body: {
          domain: 'exchange-rate-cache',
          humanConfirmationToken: 'preview-rebuild',
        },
      },
    );
    requestLocalApi.mockClear();

    await confirmProfileDomainRebuild({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: 'preview-rebuild',
      humanConfirmed: true,
      trustedSourceTicket: 'trusted-source-ticket-unit',
    });
    expect(requestLocalApi).toHaveBeenCalledWith(
      '/api/app/profile-maintenance/confirm',
      {
        method: 'POST',
        body: {
          command: 'rebuild-domain',
          confirmation: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
          domain: 'exchange-rate-cache',
          humanConfirmationToken: 'preview-rebuild',
          trustedSourceTicket: 'trusted-source-ticket-unit',
        },
      },
    );
  });

  it('rejects renderer-supplied rebuild rows or proof before making a request', () => {
    expect(() => confirmProfileDomainRebuild({
      domain: 'exchange-rate-cache',
      humanConfirmationToken: 'preview-rebuild',
      humanConfirmed: true,
      trustedSourceTicket: 'forged-ticket',
      replacementRows: [{ requested_date: 'attacker-controlled' }],
      proof: { rowsSha256: 'self-computed' },
    })).toThrow('PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN');
    expect(requestLocalApi).not.toHaveBeenCalled();
  });
});
