import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StructuredSettingsLayout from './StructuredSettingsLayout.jsx';
import { SAVED_CREDENTIAL_MASK } from './lib/credentialMask.js';
import { observePendingAccountRemoval, publishAccountRemovalCompletion } from './accountRemoval/services/accountRemovalCompletion.js';

const mocks = vi.hoisted(() => ({
  listPerformanceAccounts: vi.fn(),
  listPurchaseAccounts: vi.fn(),
  savePerformanceAccount: vi.fn(),
  savePurchaseAccount: vi.fn(),
  testPerformanceAccount: vi.fn(),
}));

const accountRemovalMocks = vi.hoisted(() => ({
  closeAccountRemoval: vi.fn(),
  confirmRemoval: vi.fn(),
  openAccountRemoval: vi.fn(() => Promise.resolve(null)),
  refreshPreview: vi.fn(),
}));

vi.mock('../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...mocks,
}));

vi.mock('./accountRemoval/model/useAccountRemovalFlow.js', () => ({
  useAccountRemovalFlow: () => ({
    flow: { open: false, stage: 'idle', owner: null, preview: null, operation: null },
    busy: false,
    ...accountRemovalMocks,
  }),
}));

const storageKey = 'wangzai-structured-settings-records:purchaseAccount';
const browserStorage = globalThis.localStorage;
const previousPurchaseBrowserBridge = globalThis.window.wangzaiDesktop;

function buildPurchaseConfig() {
  return {
    id: 'purchaseAccount',
    listTitle: '账号列表',
    countLabel: '共 1 个账号',
    addLabel: '新增',
    removeLabel: '删除当前账号',
    mainTitle: '拍单账号资料',
    mainSubtitle: '本机加密保存采购平台登录信息与收货资料',
    badge: '本机加密',
    noteTitle: '使用说明',
    note: '不会登录采购平台。',
    avatarClass: 'store-primary',
    avatarIcon: '购',
    profileTitle: '采购账号',
    profileSubtitle: '本机加密保存',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '配置依据',
    sideChip: { label: '本地规则', color: 'primary' },
    records: [
      {
        id: 'purchase-main',
        title: '1688采购号',
        status: '待配置',
        statusColor: 'default',
        values: {
          accountAlias: '1688采购号',
          platformName: '1688',
          platformUrl: 'https://www.1688.com/',
          loginAccount: '',
          loginPassword: '',
          recipientNickname: '',
          recipientPhone: '',
          recipientAddress: '',
        },
      },
    ],
    fields: [
      {
        id: 'platformName',
        label: '采购平台',
        options: ['拼多多', '天猫', '淘宝', '1688'].map((value) => ({ label: value, value })),
      },
      {
        id: 'accountAlias',
        label: '账号简称',
        options: ['拼多多采购号', '天猫采购号', '淘宝采购号', '1688采购号'].map((value) => ({ label: value, value })),
      },
      { id: 'loginAccount', label: '登录账号' },
      { id: 'loginPassword', label: '登录密码', type: 'password' },
      { id: 'recipientNickname', label: '收件人昵称' },
      { id: 'recipientPhone', label: '收货手机号' },
      { id: 'recipientAddress', label: '收货地址' },
    ],
    profileItems: [],
    apiChecks: [],
    actions: ['新增账号', '设为默认', '检查本地资料'],
  };
}

afterEach(() => {
  browserStorage.clear();
  if (previousPurchaseBrowserBridge === undefined) delete globalThis.window.wangzaiDesktop;
  else globalThis.window.wangzaiDesktop = previousPurchaseBrowserBridge;
  vi.clearAllMocks();
});

describe('StructuredSettingsLayout purchase-account SQLite-only behavior', () => {
  it('removes the observed completed purchase account without overwriting another account unsaved form', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [
      { id: 'pending-purchase-old', name: '1688采购号', platformName: '1688', platformUrl: 'https://www.1688.com/', loginAccount: 'old-observed-login', isDefault: true },
      { id: 'pending-purchase-other', name: '淘宝采购号', platformName: '淘宝', platformUrl: 'https://www.taobao.com/', loginAccount: 'other-login', isDefault: false },
    ] });
    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);
    await screen.findByDisplayValue('old-observed-login');
    const owner = { ownerType: 'purchase_account', ownerId: 'pending-purchase-old' };
    act(() => observePendingAccountRemoval({ operationId: 'purchase-observed-completion-view', pendingOwner: owner }));
    fireEvent.click(screen.getByRole('button', { name: /淘宝采购号/u }));
    fireEvent.change(screen.getByLabelText('收件人昵称'), { target: { value: '未保存的新昵称' } });
    act(() => publishAccountRemovalCompletion({ operationId: 'purchase-observed-completion-view', completed: true }, owner));
    expect(screen.getByLabelText('收件人昵称')).toHaveValue('未保存的新昵称');
    expect(screen.getByLabelText('登录账号')).toHaveValue('other-login');
    expect(screen.queryByRole('button', { name: /1688采购号/u })).not.toBeInTheDocument();
    expect(mocks.listPurchaseAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.savePurchaseAccount).not.toHaveBeenCalled();
  });
  it('omits the retired purchase-account explanation card when disabled by configuration', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [] });
    const config = buildPurchaseConfig();
    config.showNote = false;

    const { container } = render(<StructuredSettingsLayout config={config} actionNote="" onAction={() => {}} />);

    await waitFor(() => expect(mocks.listPurchaseAccounts).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.api-check-card')).toBeNull();
    expect(screen.queryByText('配置依据')).not.toBeInTheDocument();
    expect(screen.queryByText('使用说明')).not.toBeInTheDocument();
    expect(screen.queryByText('不会登录采购平台。')).not.toBeInTheDocument();
  });

  it('ignores a retired browser value, reads only the canonical account, and renders only a saved password marker', async () => {
    const retiredBrowserValue = JSON.stringify(
      [
        {
          id: 'purchase-main',
          title: '浏览器旧账号',
          values: {
            accountAlias: '浏览器旧账号',
            platformName: '旧平台',
            loginAccount: 'retired-browser-login',
            loginPassword: 'legacy-purchase-password',
          },
        },
      ]
    );
    browserStorage.setItem(
      storageKey,
      retiredBrowserValue
    );
    const canonicalAccount = {
      id: 'purchase-main',
      name: '1688采购号',
      platformName: '1688',
      loginAccount: 'seller-a',
      hasLoginPassword: true,
      platformUrl: 'https://www.1688.com/',
      recipientNickname: '七号仓',
      recipientPhone: '13800000000',
      recipientAddress: '凤凰北路15号',
      isDefault: false,
    };
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [canonicalAccount] });

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('seller-a');
    expect(mocks.listPurchaseAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.listPurchaseAccounts).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.savePurchaseAccount).not.toHaveBeenCalled();
    expect(browserStorage.getItem(storageKey)).toBe(retiredBrowserValue);
    const passwordInput = screen.getByLabelText('登录密码');
    expect(passwordInput).toHaveValue(SAVED_CREDENTIAL_MASK);
    expect(screen.getAllByText('••••••••••').length).toBeGreaterThan(0);
  });

  it('hydrates the persisted Cookie status and offers a standalone re-login action', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({
      accounts: [{
        id: 'purchase-login-saved',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        browserLoginStatus: '已登录',
        cookieStatus: 'Cookie 已保存',
        lastLoginVerifiedAt: '2026-08-11T08:30:00.000Z',
      }],
    });
    globalThis.window.wangzaiDesktop = {
      purchaseBrowser: {
        command: vi.fn(),
        onEvent: vi.fn(() => () => undefined),
      },
    };

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    expect(await screen.findByRole('button', { name: '重新登录' })).not.toBeDisabled();
    expect(screen.getAllByText('Cookie 已保存').length).toBeGreaterThan(0);
    expect(screen.getAllByText('登录已保存').length).toBeGreaterThan(0);
    expect(document.querySelector('.purchase-browser-login-viewport')).toBeNull();
  });

  it('sends a replacement password only to local-api when the user explicitly saves the account', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'purchase-a',
          name: '1688采购号',
          platformName: '1688',
          platformUrl: 'https://www.1688.com/',
          loginAccount: 'seller-a',
          hasLoginPassword: true,
          recipientNickname: '七号仓',
          recipientPhone: '13800000000',
          recipientAddress: '凤凰北路15号',
          isDefault: true,
        },
      ],
    });
    mocks.savePurchaseAccount.mockResolvedValue({
      account: {
        id: 'purchase-a',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        loginAccount: 'seller-a',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: true,
      },
    });

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('seller-a');
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'replacement-purchase-password' } });
    fireEvent.click(screen.getByRole('button', { name: '检查本地资料' }));
    await waitFor(() =>
      expect(mocks.savePurchaseAccount).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'purchase-a', loginPassword: 'replacement-purchase-password' }),
        { timeoutMs: 30000 }
      )
    );
    expect(browserStorage.getItem(storageKey)).toBeNull();
  });

  it('uses local-api for the default switch and deletion instead of restoring browser persistence', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'purchase-a',
          name: '1688采购号',
          platformName: '1688',
          platformUrl: 'https://www.1688.com/',
          loginAccount: 'seller-a',
          hasLoginPassword: true,
          recipientNickname: '七号仓',
          recipientPhone: '13800000000',
          recipientAddress: '凤凰北路15号',
          isDefault: false,
        },
      ],
    });
    mocks.savePurchaseAccount.mockResolvedValue({
      account: {
        id: 'purchase-a',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        loginAccount: 'seller-a',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: true,
      },
    });
    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('seller-a');
    fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
    await waitFor(() =>
      expect(mocks.savePurchaseAccount).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'purchase-a', isDefault: true }),
        { timeoutMs: 30000 }
      )
    );
    fireEvent.click(screen.getByRole('button', { name: '删除当前账号' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [owner, options] = accountRemovalMocks.openAccountRemoval.mock.calls[0];
    expect(owner).toEqual({ ownerType: 'purchase_account', ownerId: 'purchase-a' });
    expect(screen.getByDisplayValue('seller-a')).toBeInTheDocument();
    await act(async () => {
      await options.onCompleted({ completed: true });
    });
    await waitFor(() => expect(screen.queryByDisplayValue('seller-a')).not.toBeInTheDocument());
    expect(browserStorage.getItem(storageKey)).toBeNull();
  });

  it('keeps platform, account alias, and fixed entry URL synchronized in both directions', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'purchase-a',
          name: '1688采购号',
          platformName: '1688',
          platformUrl: 'https://www.1688.com/',
          loginAccount: 'seller-a',
          hasLoginPassword: true,
          recipientNickname: '七号仓',
          recipientPhone: '13800000000',
          recipientAddress: '凤凰北路15号',
          isDefault: false,
        },
      ],
    });
    mocks.savePurchaseAccount.mockImplementation(async (payload) => ({
      account: {
        id: payload.id,
        ...payload,
        hasLoginPassword: true,
      },
    }));

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('seller-a');
    const bodyOverflowBeforeOpen = document.body.style.overflow;
    const bodyPaddingRightBeforeOpen = document.body.style.paddingRight;
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '采购平台' }));
    expect(document.body.style.overflow).toBe(bodyOverflowBeforeOpen);
    expect(document.body.style.paddingRight).toBe(bodyPaddingRightBeforeOpen);
    fireEvent.click(screen.getByRole('option', { name: '拼多多' }));
    expect(screen.getByRole('combobox', { name: '账号简称' })).toHaveTextContent('拼多多采购号');
    expect(screen.getByText('https://mobile.yangkeduo.com/')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '账号简称' }));
    expect(document.body.style.overflow).toBe(bodyOverflowBeforeOpen);
    expect(document.body.style.paddingRight).toBe(bodyPaddingRightBeforeOpen);
    fireEvent.click(screen.getByRole('option', { name: '淘宝采购号' }));
    expect(screen.getByRole('combobox', { name: '采购平台' })).toHaveTextContent('淘宝');
    expect(screen.getByText('https://www.taobao.com/')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '检查本地资料' }));
    await waitFor(() =>
      expect(mocks.savePurchaseAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '淘宝采购号',
          platformName: '淘宝',
          platformUrl: 'https://www.taobao.com/',
          recipientNickname: '七号仓',
          recipientPhone: '13800000000',
          recipientAddress: '凤凰北路15号',
        }),
        { timeoutMs: 30000 }
      )
    );
  });

  it('enables opening the standalone browser only after the purchase account is loaded from local-api', async () => {
    const accountId = 'purchase-browser-account';
    mocks.listPurchaseAccounts.mockResolvedValue({
      accounts: [{
        id: accountId,
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        loginAccount: 'seller-a',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: true,
      }],
    });
    const command = vi.fn(async (input) => ({
      ok: true,
      engine: 'cef',
      activeTabId: 'tab-purchase-browser',
      visible: input.command === 'open',
      tabs: [{
        tabId: 'tab-purchase-browser',
        accountId,
        engine: 'cef',
        title: '1688 登录',
        url: 'https://www.1688.com/',
        loading: false,
        crashed: false,
        extension: { installState: 'active', extensionVersion: '1.0.0' },
      }],
    }));
    globalThis.window.wangzaiDesktop = {
      purchaseBrowser: {
        command,
        onEvent: vi.fn(() => () => undefined),
      },
    };

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    const openButton = await screen.findByRole('button', { name: '打开登录窗口' });
    expect(openButton).not.toBeDisabled();
    fireEvent.click(openButton);
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      command: 'open',
      accountId,
      accountLabel: '1688采购号',
      platformName: '1688',
      url: 'https://www.1688.com/',
    }));
    expect(command.mock.calls.some(([input]) => input.command === 'embed-bounds')).toBe(false);
    expect(document.querySelector('.purchase-browser-login-viewport')).toBeNull();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ command: 'hide' }));
    expect(screen.getByRole('button', { name: '打开登录窗口' })).toBeInTheDocument();
  });

  it('keeps the standalone-browser button disabled for a local draft account', async () => {
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [] });
    const command = vi.fn();
    globalThis.window.wangzaiDesktop = {
      purchaseBrowser: {
        command,
        onEvent: vi.fn(() => () => undefined),
      },
    };

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={() => {}} />);

    const openButton = await screen.findByRole('button', { name: '打开登录窗口' });
    expect(openButton).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });

  it('switches three saved platform accounts 300 times without opening or prewarming a browser', async () => {
    const accounts = [
      {
        id: 'purchase-1688',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        loginAccount: 'seller-1688',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: true,
      },
      {
        id: 'purchase-taobao',
        name: '淘宝采购号',
        platformName: '淘宝',
        platformUrl: 'https://www.taobao.com/',
        loginAccount: 'seller-taobao',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: false,
      },
      {
        id: 'purchase-pdd',
        name: '拼多多采购号',
        platformName: '拼多多',
        platformUrl: 'https://mobile.yangkeduo.com/',
        loginAccount: 'seller-pdd',
        hasLoginPassword: true,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: false,
      },
    ];
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts });
    const command = vi.fn();
    const onAction = vi.fn();
    globalThis.window.wangzaiDesktop = {
      purchaseBrowser: {
        command,
        onEvent: vi.fn(() => () => undefined),
      },
    };

    render(<StructuredSettingsLayout config={buildPurchaseConfig()} actionNote="" onAction={onAction} />);

    await screen.findByDisplayValue('seller-1688');
    const accountButtons = accounts.map((account) => screen.getByRole('button', { name: new RegExp(account.name) }));
    await act(async () => {
      for (let index = 0; index < 300; index += 1) {
        fireEvent.click(accountButtons[index % accountButtons.length]);
      }
    });

    expect(screen.getByDisplayValue('seller-pdd')).toBeInTheDocument();
    expect(command).not.toHaveBeenCalled();
    expect(mocks.listPurchaseAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.savePurchaseAccount).not.toHaveBeenCalled();
  });

  it('can save a QR or verification-code account without a password before opening the browser', async () => {
    const config = buildPurchaseConfig();
    config.records[0].values = {
      ...config.records[0].values,
      recipientNickname: '七号仓',
      recipientPhone: '13800000000',
      recipientAddress: '凤凰北路15号',
      loginAccount: '',
      loginPassword: '',
    };
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [] });
    mocks.savePurchaseAccount.mockResolvedValue({
      account: {
        id: 'qr-account',
        name: '1688采购号',
        platformName: '1688',
        platformUrl: 'https://www.1688.com/',
        loginAccount: '',
        hasLoginPassword: false,
        recipientNickname: '七号仓',
        recipientPhone: '13800000000',
        recipientAddress: '凤凰北路15号',
        isDefault: false,
      },
    });

    render(<StructuredSettingsLayout config={config} actionNote="" onAction={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: '检查本地资料' }));
    await waitFor(() => expect(mocks.savePurchaseAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        platformName: '1688',
        loginAccount: '',
        recipientNickname: '七号仓',
      }),
      { timeoutMs: 30000 }
    ));
    expect(await screen.findByText('账号资料已加密保存；请点击“打开登录窗口”完成验证码或扫码登录。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开登录窗口' })).not.toBeDisabled();
  });

});

