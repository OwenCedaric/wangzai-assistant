import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelApiSettingsPanel from './ModelApiSettingsPanel.jsx';
import { SAVED_CREDENTIAL_MASK } from './lib/credentialMask.js';
import { readSavedModelApiState } from './lib/modelApiSettings.jsx';
import { observePendingAccountRemoval, publishAccountRemovalCompletion } from './accountRemoval/services/accountRemovalCompletion.js';

const mocks = vi.hoisted(() => ({
  listModelApiAccounts: vi.fn(),
  saveModelApiAccount: vi.fn(),
}));

const accountRemovalMocks = vi.hoisted(() => ({
  closeAccountRemoval: vi.fn(),
  confirmRemoval: vi.fn(),
  openAccountRemoval: vi.fn(() => Promise.resolve(null)),
  refreshPreview: vi.fn(),
}));

vi.mock('../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listModelApiAccounts: mocks.listModelApiAccounts,
  saveModelApiAccount: mocks.saveModelApiAccount,
}));

vi.mock('./accountRemoval/model/useAccountRemovalFlow.js', () => ({
  useAccountRemovalFlow: () => ({
    flow: { open: false, stage: 'idle', owner: null, preview: null, operation: null },
    busy: false,
    ...accountRemovalMocks,
  }),
}));
const savedAccount = {
  id: 'model-a',
  apiAlias: 'image2 主接口',
  provider: 'codesonline',
  websiteUrl: 'https://images.example.invalid/personal/dashboard',
  loginAccount: 'model-user',
  hasLoginPassword: true,
  baseUrl: 'https://images.example.invalid/v1',
  hasApiKey: true,
  defaultModel: 'gpt-image-2',
  usageScene: '文生图',
  availableModels: [
    {
      id: 'gpt-image-2',
      label: 'gpt-image-2',
      capabilities: ['image-edit', 'image-generation'],
      options: {
        quality: [
          { id: 'high', label: '高清' },
          { id: 'draft', label: '草稿' },
        ],
      },
    },
    { id: 'gpt-image-2-adobe', label: 'Adobe 4K', capabilities: ['image-generation'] },
    { id: 'gemini-banana-2.0-pro', label: 'Banana Pro 4K', capabilities: ['text-generation'] },
    { id: 'gpt-5-4-thinking', label: '文本模型', capabilities: ['text-generation'] },
    { id: 'seedance-2.0', label: '视频模型', capabilities: [] },
  ],
  capabilities: ['image-edit', 'image-generation'],
  discoveryVerified: true,
  quality: 'high',
  isDefault: true,
  updatedAt: '2026-07-12T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('ModelApiSettingsPanel encrypted model accounts', () => {
  it('removes a pending-task completed old interface without reloading or losing another interface draft', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount, { ...savedAccount, id: 'model-b', isDefault: false, websiteUrl: 'https://other.example/' }] });
    render(<ModelApiSettingsPanel onAction={() => {}} />);
    await screen.findByLabelText('接口地址');
    const owner = { ownerType: 'model_api_account', ownerId: savedAccount.id };
    act(() => observePendingAccountRemoval({ operationId: 'model-view-observed-completion', pendingOwner: owner }));
    fireEvent.click(screen.getByText('配置 2'));
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://other.example/unsaved' } });
    act(() => publishAccountRemovalCompletion({ operationId: 'model-view-observed-completion', completed: true }, owner));
    expect(screen.getByLabelText('接口地址')).toHaveValue('https://other.example/unsaved');
    expect(readSavedModelApiState().interfaces.map(item => item.id)).toEqual(['model-b']);
    expect(mocks.listModelApiAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.saveModelApiAccount).not.toHaveBeenCalled();
  });
  it('keeps a same-id account that was newly saved after the old binding was observed', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount] });
    mocks.saveModelApiAccount.mockResolvedValue({ account: { ...savedAccount, updatedAt: '2026-09-05T16:00:00Z' } });
    render(<ModelApiSettingsPanel onAction={() => {}} />);
    await screen.findByLabelText('接口地址');
    const owner = { ownerType: 'model_api_account', ownerId: savedAccount.id };
    act(() => observePendingAccountRemoval({ operationId: 'model-view-rebound-preserved', pendingOwner: owner }));
    fireEvent.click(screen.getByRole('button', { name: '保存并自动识别' }));
    await waitFor(() => expect(readSavedModelApiState().interfaces[0].savedAt).toBe('2026-09-05T16:00:00Z'));
    act(() => publishAccountRemovalCompletion({ operationId: 'model-view-rebound-preserved', completed: true }, owner));
    expect(readSavedModelApiState().interfaces[0].id).toBe(savedAccount.id);
    expect(screen.getByLabelText('接口地址')).toBeInTheDocument();
  });
  it('shows only endpoint and API key and clears legacy login credentials when saving', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount] });
    mocks.saveModelApiAccount.mockResolvedValue({ account: savedAccount });

    render(<ModelApiSettingsPanel onAction={() => {}} />);

    await screen.findByLabelText('接口地址');
    const apiKeyInput = screen.getByLabelText('API Key');
    expect(apiKeyInput).toHaveValue(SAVED_CREDENTIAL_MASK);
    expect(screen.queryByLabelText('账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();

    fireEvent.change(apiKeyInput, { target: { value: 'replacement-model-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并自动识别' }));

    await waitFor(() =>
      expect(mocks.saveModelApiAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'model-a',
          websiteUrl: 'https://images.example.invalid/personal/dashboard',
          loginAccount: '',
          loginPassword: '',
          apiKey: 'replacement-model-api-key',
          isDefault: true,
        }),
        { timeoutMs: 30000 }
      )
    );
    expect(JSON.stringify(mocks.listModelApiAccounts.mock.results)).not.toContain('replacement-model-api-key');
  });

  it('only exposes endpoint and API key and hides discovered technical fields', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount] });
    const { container } = render(<ModelApiSettingsPanel onAction={() => {}} />);

    await screen.findByLabelText('接口地址');
    expect(screen.getByLabelText('接口地址')).toBeInTheDocument();
    expect(screen.queryByLabelText('账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('生图模型')).toBeInTheDocument();
    expect(screen.getByLabelText('质量')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('生图模型'));
    expect(screen.getByRole('option', { name: 'gpt-image-2' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Adobe 4K' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Banana Pro 4K' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '文本模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '视频模型' })).not.toBeInTheDocument();
    expect(screen.queryByText('识别来源')).not.toBeInTheDocument();
    expect(screen.queryByText('https://images.example.invalid/v1')).not.toBeInTheDocument();
    expect(screen.queryByText('codesonline')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API 地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('默认模型')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '识别接口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '校验配置' })).not.toBeInTheDocument();
    expect(container.querySelector('.api-check-card')).toBeNull();
  });

  it('keeps the interface visible until unified account removal reports completed', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount] });
    render(<ModelApiSettingsPanel onAction={() => {}} />);

    await screen.findByLabelText('接口地址');
    fireEvent.click(screen.getByRole('button', { name: '删除当前配置' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [owner, options] = accountRemovalMocks.openAccountRemoval.mock.calls[0];
    expect(owner).toEqual({ ownerType: 'model_api_account', ownerId: 'model-a' });
    expect(screen.getByLabelText('接口地址')).toBeInTheDocument();

    await act(async () => {
      await options.onCompleted({ completed: true });
    });
    await waitFor(() => expect(screen.queryByDisplayValue(savedAccount.websiteUrl)).not.toBeInTheDocument());
  });

  it('clears a stale model API row when unified removal reports that the owner is already missing', async () => {
    mocks.listModelApiAccounts.mockResolvedValue({ accounts: [savedAccount] });
    render(<ModelApiSettingsPanel onAction={() => {}} />);

    await screen.findByLabelText('接口地址');
    fireEvent.click(screen.getByRole('button', { name: '删除当前配置' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [, options] = accountRemovalMocks.openAccountRemoval.mock.calls[0];

    await act(async () => {
      await options.onMissing({ ownerType: 'model_api_account', ownerId: 'model-a' });
    });
    await waitFor(() => expect(screen.queryByDisplayValue(savedAccount.websiteUrl)).not.toBeInTheDocument());
  });
});
