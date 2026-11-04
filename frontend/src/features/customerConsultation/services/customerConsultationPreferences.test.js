import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));

import {
  CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE,
  readCustomerConsultationPreferences,
  updateCustomerConsultationPreferences,
} from './customerConsultationPreferences.js';

describe('customer consultation preferences', () => {
  beforeEach(() => {
    mocks.getProfileSetting.mockReset();
    mocks.saveProfileSetting.mockReset();
  });

  it('persists drafts and quick replies in the exact account scope', async () => {
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.saveProfileSetting.mockImplementation(async (_namespace, value) => ({ setting: { value } }));

    await updateCustomerConsultationPreferences('shop-generation-1', {
      drafts: { 'chat-1': '稍后回复' },
      customQuickReplies: [{ id: 'custom-1', text: 'Здравствуйте!' }],
    });

    expect(mocks.saveProfileSetting).toHaveBeenCalledWith(
      CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE,
      expect.objectContaining({
        version: 1,
        scopes: expect.objectContaining({
          'shop-generation-1': expect.objectContaining({
            drafts: { 'chat-1': '稍后回复' },
            customQuickReplies: [expect.objectContaining({ text: 'Здравствуйте!', custom: true })],
          }),
        }),
      }),
      expect.objectContaining({ timeoutMs: 30000 })
    );
  });

  it('reads only the requested account scope', async () => {
    mocks.getProfileSetting.mockResolvedValue({
      setting: {
        value: {
          version: 1,
          scopes: {
            first: { drafts: { a: 'A' }, customQuickReplies: [] },
            second: { drafts: { b: 'B' }, customQuickReplies: [] },
          },
        },
      },
    });
    await expect(readCustomerConsultationPreferences('second')).resolves.toEqual(
      expect.objectContaining({ drafts: { b: 'B' } })
    );
  });
});
