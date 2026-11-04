import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { structuredSettingsLayouts } from '../../shared/config/appConfigRuntime.jsx';
import StructuredSettingsLayout from './StructuredSettingsLayout.jsx';

const mocks = vi.hoisted(() => ({
  deleteIntegrationProfile: vi.fn(),
  deletePerformanceAccount: vi.fn(),
  deletePurchaseAccount: vi.fn(),
  listIntegrationProfiles: vi.fn(),
  listPerformanceAccounts: vi.fn(),
  listPurchaseAccounts: vi.fn(),
  saveIntegrationProfile: vi.fn(),
  savePerformanceAccount: vi.fn(),
  savePurchaseAccount: vi.fn(),
  testPerformanceAccount: vi.fn(),
  testPlatformIntegration: vi.fn(),
}));

const accountRemovalMocks = vi.hoisted(() => ({
  closeAccountRemoval: vi.fn(),
  confirmRemoval: vi.fn(),
  openAccountRemoval: vi.fn(() => Promise.resolve(null)),
  refreshPreview: vi.fn(),
}));

const ozonBrowserMocks = vi.hoisted(() => ({
  hide: vi.fn(async () => ({ ok: true })),
  open: vi.fn(async () => ({ tab: { tabId: 'ozon-login-tab' } })),
  waitForLogin: vi.fn(async () => ({ result: { ok: true } })),
  waitForObserver: vi.fn(async () => ({ result: { extensionVersion: '2.0.0' } })),
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

vi.mock('./services/ozonBrowserLoginService.js', () => ({
  hideOzonBrowserLogin: ozonBrowserMocks.hide,
  openOzonBrowserLogin: ozonBrowserMocks.open,
  waitForOzonBrowserLogin: ozonBrowserMocks.waitForLogin,
}));

vi.mock('./services/ozonBrowserDataService.js', () => ({
  waitForOzonBrowserDataObserver: ozonBrowserMocks.waitForObserver,
}));

const storageKey = 'wangzai-structured-settings-records:platformApi';
const browserStorage = globalThis.localStorage;

function buildPlatformConfig() {
  return {
    id: 'platformApi',
    listTitle: '已添加接口',
    countLabel: '共 1 个接口',
    addLabel: '添加接口',
    removeLabel: '删除当前接口',
    mainTitle: '外部接口配置',
    mainSubtitle: '选择服务后自动带出固定规则',
    badge: '统一接入',
    noteTitle: '接入说明',
    note: '不会自动执行外部写入。',
    avatarClass: 'store-primary',
    avatarIcon: '接',
    profileTitle: '接口概览',
    profileSubtitle: '统一管理外部接口',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '用途与规则',
    sideChip: { label: '自动带出', color: 'primary' },
    records: [
      {
        id: 'platform-custom',
        title: '内部工具接口',
        meta: '工具服务',
        status: '本地草稿',
        statusColor: 'default',
        values: {
          integrationType: 'tool',
          platformName: '内部工具接口',
          apiType: '工具服务',
          authMode: '本机配置',
          configStatus: '本地草稿',
          performanceClientId: '',
          performanceClientSecret: '',
          tokenStatus: '不适用',
          readScope: '配置读取',
          writeScope: '人工确认',
          remark: '',
        },
      },
    ],
    fields: [
      { id: 'integrationType', label: '外部服务' },
      { id: 'platformName', label: '配置名称' },
      { id: 'performanceClientId', label: 'Client ID', integrationTypes: ['ozon-performance'] },
      {
        id: 'performanceClientSecret',
        label: 'Client Secret',
        type: 'password',
        integrationTypes: ['ozon-performance'],
      },
      { id: 'remark', label: '备注（选填）' },
    ],
    profileItems: [],
    apiChecks: [],
    actions: ['测试连接', '保存接口资料', '打开日志'],
  };
}

afterEach(() => {
  browserStorage.clear();
  vi.clearAllMocks();
});

describe('StructuredSettingsLayout integration-profile SQLite-only behavior', () => {
  it('shows an honest loading state instead of claiming that a fresh account list is empty', async () => {
    let resolveProfiles;
    let resolvePerformance;
    mocks.listIntegrationProfiles.mockImplementation(() => new Promise((resolve) => {
      resolveProfiles = resolve;
    }));
    mocks.listPerformanceAccounts.mockImplementation(() => new Promise((resolve) => {
      resolvePerformance = resolve;
    }));

    const { container } = render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    expect(await screen.findByText('正在读取本机接口账号…')).toBeInTheDocument();
    expect(container.querySelector('.api-check-card')).toBeNull();
    expect(screen.queryByText('用途与规则')).not.toBeInTheDocument();
    expect(screen.getByText('正在读取已保存接口')).toBeInTheDocument();
    expect(screen.queryByText('共 0 个接口')).not.toBeInTheDocument();
    expect(screen.queryByText('还没有外部接口')).not.toBeInTheDocument();

    resolveProfiles({ profiles: [] });
    resolvePerformance({ accounts: [] });
    expect(await screen.findByText('共 0 个接口')).toBeInTheDocument();
  });

  it('loads platform profiles and Performance accounts in parallel and renders the fast source immediately', async () => {
    let resolveProfiles;
    mocks.listIntegrationProfiles.mockImplementation(() => new Promise((resolve) => {
      resolveProfiles = resolve;
    }));
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: 'performance-fast',
        name: '快速返回的 Performance 账号',
        hasClientId: true,
        hasClientSecret: true,
        status: 'active',
      }],
    });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(1));
    expect(await screen.findByDisplayValue('快速返回的 Performance 账号')).toBeInTheDocument();

    resolveProfiles({ profiles: [] });
    await waitFor(() => expect(screen.getByText('共 1 个接口')).toBeInTheDocument());
  });

  it('keeps both independent account sources when platform profiles resolve first', async () => {
    let resolveProfiles;
    let resolvePerformance;
    mocks.listIntegrationProfiles.mockImplementation(() => new Promise((resolve) => {
      resolveProfiles = resolve;
    }));
    mocks.listPerformanceAccounts.mockImplementation(() => new Promise((resolve) => {
      resolvePerformance = resolve;
    }));

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);
    await waitFor(() => expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveProfiles({
        profiles: [{
          id: 'profile-first',
          integrationType: 'seerfar-open-api',
          platformName: '先返回的平台接口',
          hasApiKey: true,
        }],
      });
    });
    expect(await screen.findByRole('button', { name: /先返回的平台接口/u })).toBeInTheDocument();

    await act(async () => {
      resolvePerformance({
        accounts: [{
          id: 'performance-second',
          name: '后返回的 Performance 账号',
          hasClientId: true,
          hasClientSecret: true,
          status: 'active',
        }],
      });
    });

    expect(await screen.findByRole('button', { name: /后返回的 Performance 账号/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /先返回的平台接口/u })).toBeInTheDocument();
    expect(screen.getByText('共 2 个接口')).toBeInTheDocument();
  });

  it('keeps both independent account sources when Performance resolves first', async () => {
    let resolveProfiles;
    let resolvePerformance;
    mocks.listIntegrationProfiles.mockImplementation(() => new Promise((resolve) => {
      resolveProfiles = resolve;
    }));
    mocks.listPerformanceAccounts.mockImplementation(() => new Promise((resolve) => {
      resolvePerformance = resolve;
    }));

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);
    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolvePerformance({
        accounts: [{
          id: 'performance-first',
          name: '先返回的 Performance 账号',
          hasClientId: true,
          hasClientSecret: true,
          status: 'active',
        }],
      });
    });
    expect(await screen.findByRole('button', { name: /先返回的 Performance 账号/u })).toBeInTheDocument();

    await act(async () => {
      resolveProfiles({
        profiles: [{
          id: 'profile-second',
          integrationType: 'seerfar-open-api',
          platformName: '后返回的平台接口',
          hasApiKey: true,
        }],
      });
    });

    expect(await screen.findByRole('button', { name: /后返回的平台接口/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /先返回的 Performance 账号/u })).toBeInTheDocument();
    expect(screen.getByText('共 2 个接口')).toBeInTheDocument();
  });

  it('keeps the last successful source visible while only the failed source retries', async () => {
    mocks.listIntegrationProfiles.mockResolvedValueOnce({
      profiles: [{
        id: 'profile-stable',
        integrationType: 'seerfar-open-api',
        platformName: '已缓存的平台接口',
        hasApiKey: true,
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValueOnce({
      accounts: [{ id: 'performance-old', name: '旧 Performance 账号', status: 'inactive' }],
    });

    const initialConfig = buildPlatformConfig();
    const { rerender } = render(
      <StructuredSettingsLayout config={initialConfig} actionNote="" onAction={() => {}} />
    );
    expect(await screen.findByDisplayValue('已缓存的平台接口')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /旧 Performance 账号/u })).toBeInTheDocument();

    mocks.listIntegrationProfiles
      .mockRejectedValueOnce(new Error('profiles temporarily unavailable'))
      .mockRejectedValueOnce(new Error('profiles temporarily unavailable'));
    mocks.listPerformanceAccounts.mockResolvedValueOnce({
      accounts: [{ id: 'performance-new', name: '新 Performance 账号', status: 'active' }],
    });

    rerender(
      <StructuredSettingsLayout config={{ ...initialConfig }} actionNote="" onAction={() => {}} />
    );

    expect(await screen.findByRole('button', { name: /新 Performance 账号/u })).toBeInTheDocument();
    expect(screen.getByDisplayValue('已缓存的平台接口')).toBeInTheDocument();
    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/部分账号读取失败，已保留上次数据/u)).toBeInTheDocument();
    expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(2);
  });

  it('preserves the last Performance source while a successful platform refresh replaces only profiles', async () => {
    mocks.listIntegrationProfiles.mockResolvedValueOnce({
      profiles: [{
        id: 'profile-old',
        integrationType: 'seerfar-open-api',
        platformName: '旧平台接口',
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValueOnce({
      accounts: [{ id: 'performance-stable', name: '稳定 Performance 账号', status: 'active' }],
    });

    const initialConfig = buildPlatformConfig();
    const { rerender } = render(
      <StructuredSettingsLayout config={initialConfig} actionNote="" onAction={() => {}} />
    );
    expect(await screen.findByRole('button', { name: /稳定 Performance 账号/u })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /旧平台接口/u })).toBeInTheDocument();

    mocks.listIntegrationProfiles.mockResolvedValueOnce({
      profiles: [{
        id: 'profile-new',
        integrationType: 'seerfar-open-api',
        platformName: '新平台接口',
      }],
    });
    mocks.listPerformanceAccounts
      .mockRejectedValueOnce(new Error('performance temporarily unavailable'))
      .mockRejectedValueOnce(new Error('performance temporarily unavailable'));

    rerender(
      <StructuredSettingsLayout config={{ ...initialConfig }} actionNote="" onAction={() => {}} />
    );

    expect(await screen.findByRole('button', { name: /新平台接口/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /稳定 Performance 账号/u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /旧平台接口/u })).not.toBeInTheDocument();
    expect(await screen.findByText(/部分账号读取失败，已保留上次数据/u)).toBeInTheDocument();
  });

  it('shows every new interface card immediately and saves only the selected draft', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockResolvedValue({
      profile: {
        id: 'seerfar-saved',
        integrationType: 'seerfar-open-api',
        platformName: 'Seerfar Open API',
        baseUrl: 'https://api.seerfar.cn',
        apiType: '市场数据',
        authMode: 'Bearer API Key',
        configStatus: '已保存',
        hasApiKey: true,
      },
    });

    render(
      <StructuredSettingsLayout
        config={structuredSettingsLayouts.platformApi}
        actionNote=""
        onAction={() => {}}
      />
    );

    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(1));
    expect(screen.getByText('共 0 个接口')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加接口' }));
    expect(screen.getByText('共 1 个接口')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /外部接口 1.*未保存/u })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加接口' }));
    expect(screen.getByText('共 2 个接口')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /外部接口 2.*未保存/u })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /外部接口 1.*未保存/u }));
    fireEvent.mouseDown(screen.getByLabelText('外部服务'));
    fireEvent.click(await screen.findByRole('option', { name: 'Seerfar Open API' }));
    fireEvent.change(screen.getByLabelText(/API Key \/ Token/u), { target: { value: 'seerfar-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存接口资料' }));

    await waitFor(() => expect(mocks.saveIntegrationProfile).toHaveBeenCalledTimes(1));
    expect(screen.getByText('共 2 个接口')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Seerfar Open API.*已保存/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /外部接口 2.*未保存/u })).toBeInTheDocument();
  });

  it('uses a provider preset so users only fill connection essentials', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });

    render(
      <StructuredSettingsLayout
        config={structuredSettingsLayouts.platformApi}
        actionNote=""
        onAction={() => {}}
      />
    );

    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByLabelText('外部服务'));
    fireEvent.click(await screen.findByRole('option', { name: 'Seerfar Open API' }));

    expect(screen.getByDisplayValue('Seerfar Open API')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://api.seerfar.cn')).toBeInTheDocument();
    expect(screen.getAllByText('Bearer API Key')).not.toHaveLength(0);
    expect(screen.getByLabelText(/API Key \/ Token/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('配置状态')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token 状态')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('只读范围')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('写入范围')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存接口资料' })).toBeInTheDocument();
  });

  it('requires and persists the exact shop for every independent Ozon browser login', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockImplementation(async (payload) => ({
      profile: {
        ...payload,
        configStatus: payload.configStatus || '待登录',
        tokenStatus: payload.tokenStatus || 'Cookie 未保存',
      },
    }));
    const shops = [
      { id: 'shop-a', shopAlias: 'Ozon 1店' },
      { id: 'shop-b', shopAlias: 'Ozon 2店' },
    ];

    render(
      <StructuredSettingsLayout
        config={structuredSettingsLayouts.platformApi}
        actionNote=""
        onAction={() => {}}
        shops={shops}
      />
    );

    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByLabelText('外部服务'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ozon 网页登录' }));
    expect(await screen.findByLabelText(/绑定 Ozon 店铺/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    await waitFor(() => expect(screen.getByText('Ozon 登录配置保存失败。')).toBeInTheDocument());
    expect(mocks.saveIntegrationProfile).not.toHaveBeenCalled();
    expect(ozonBrowserMocks.open).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByLabelText(/绑定 Ozon 店铺/u));
    fireEvent.click(await screen.findByRole('option', { name: 'Ozon 2店' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));

    await waitFor(() => expect(mocks.saveIntegrationProfile).toHaveBeenCalled());
    expect(mocks.saveIntegrationProfile.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        integrationType: 'ozon-browser-session',
        shopId: 'shop-b',
      })
    );
    await waitFor(() => expect(ozonBrowserMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: expect.any(String) })
    ));
  });

  it('cancels the old Ozon login attempt when another saved integration profile is selected', async () => {
    const profiles = [
      { id: 'seller-old-profile', shopId: 'shop-old', integrationType: 'ozon-browser-session', platformName: '旧店网页登录' },
      { id: 'seller-current-profile', shopId: 'shop-current', integrationType: 'ozon-browser-session', platformName: '新店网页登录' },
    ];
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockImplementation(async (payload) => ({ profile: { ...payload } }));
    let resolveOldLogin;
    ozonBrowserMocks.waitForLogin.mockImplementationOnce(() => new Promise((resolve) => { resolveOldLogin = resolve; }));
    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧店网页登录/u }));
    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 登录' }));
    await waitFor(() => expect(ozonBrowserMocks.waitForLogin).toHaveBeenCalledTimes(1));
    const oldSignal = ozonBrowserMocks.waitForLogin.mock.calls[0][0].signal;
    fireEvent.click(screen.getByRole('button', { name: /新店网页登录/u }));
    expect(oldSignal.aborted).toBe(true);

    await act(async () => { resolveOldLogin({ result: { loggedIn: true, cookieSaved: true, companyId: 'old-company' } }); });

    expect(screen.getByLabelText('配置名称')).toHaveValue('新店网页登录');
    expect(screen.getByRole('button', { name: '打开 Ozon 登录' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '取消等待' })).not.toBeInTheDocument();
    expect(ozonBrowserMocks.waitForObserver).not.toHaveBeenCalled();
    expect(ozonBrowserMocks.hide).not.toHaveBeenCalled();
    expect(mocks.saveIntegrationProfile).toHaveBeenCalledTimes(1);
  });

  it('encrypts Seerfar credentials through local-api before running the real connection adapter', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockResolvedValue({
      profile: {
        id: 'seerfar-a',
        integrationType: 'seerfar-open-api',
        platformName: 'Seerfar Open API',
        baseUrl: 'https://api.seerfar.cn',
        hasApiKey: true,
        apiKeyHint: '••••••••••',
      },
    });
    mocks.testPlatformIntegration.mockResolvedValue({
      ok: true,
      status: 'connected',
      message: 'Seerfar API Key 有效，额度接口读取成功。',
      profile: {
        id: 'seerfar-a',
        integrationType: 'seerfar-open-api',
        platformName: 'Seerfar Open API',
        baseUrl: 'https://api.seerfar.cn',
        hasApiKey: true,
        apiKeyHint: '••••••••••',
        lastTestStatus: 'connected',
        lastTestMessage: 'Seerfar API Key 有效，额度接口读取成功。',
      },
    });

    render(
      <StructuredSettingsLayout
        config={structuredSettingsLayouts.platformApi}
        actionNote=""
        onAction={() => {}}
      />
    );
    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByLabelText('外部服务'));
    fireEvent.click(await screen.findByRole('option', { name: 'Seerfar Open API' }));
    fireEvent.change(screen.getByLabelText(/API Key \/ Token/u), { target: { value: 'seerfar-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() =>
      expect(mocks.saveIntegrationProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationType: 'seerfar-open-api',
          credentials: expect.objectContaining({
            baseUrl: 'https://api.seerfar.cn',
            apiKey: 'seerfar-secret',
          }),
        }),
        { timeoutMs: 30000 }
      )
    );
    await waitFor(() =>
      expect(mocks.testPlatformIntegration).toHaveBeenCalledWith(
        { type: 'seerfar-open-api', integrationType: 'seerfar-open-api', profileId: 'seerfar-a' },
        { timeoutMs: 45000 }
      )
    );
    expect(await screen.findByText('Seerfar API Key 有效，额度接口读取成功。')).toBeInTheDocument();
  });

  it('does not recreate static platform presets after canonical local-api rows were deleted', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await waitFor(() => expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(1));
    expect(screen.getByText('共 0 个接口')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /内部工具接口/u })).not.toBeInTheDocument();
  });

  it('ignores a retired browser value and renders only canonical profile and masked Performance credential state', async () => {
    const retiredBrowserValue = JSON.stringify([
      {
        id: 'platform-custom',
        title: '浏览器旧 Performance 接口',
        values: {
          integrationType: 'ozon-performance',
          platformName: '浏览器旧 Performance 接口',
          apiType: '广告推广',
          authMode: 'client_id + client_secret',
          performanceClientSecret: 'legacy-client-secret',
          remark: 'legacy note',
        },
      },
    ]);
    browserStorage.setItem(
      storageKey,
      retiredBrowserValue
    );
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: 'platform-custom', integrationType: 'ozon-performance', platformName: 'SQLite Performance 接口',
        apiType: '广告推广', authMode: 'client_id + client_secret', configStatus: '已保存', note: 'SQLite note',
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: 'platform-custom', name: 'SQLite Performance 接口', note: 'SQLite note',
        hasClientId: true, hasClientSecret: true, status: 'inactive',
      }],
    });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('SQLite Performance 接口');
    expect(mocks.listIntegrationProfiles).toHaveBeenCalledTimes(1);
    expect(mocks.listIntegrationProfiles).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.listPerformanceAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.listPerformanceAccounts).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.saveIntegrationProfile).not.toHaveBeenCalled();
    expect(mocks.savePerformanceAccount).not.toHaveBeenCalled();
    expect(browserStorage.getItem(storageKey)).toBe(retiredBrowserValue);
    expect(screen.getByLabelText('Client Secret')).toHaveValue('••••••••••');
  });

  it('keeps a tested Performance account active when only remarks are saved', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: 'performance-active',
        name: 'Ozon Performance API',
        clientId: 'saved@advertising.performance.ozon.ru',
        hasClientId: true,
        hasClientSecret: true,
        status: 'active',
        note: 'old note',
      }],
    });
    mocks.savePerformanceAccount.mockResolvedValue({
      account: {
        id: 'performance-active',
        name: 'Ozon Performance API',
        clientId: 'saved@advertising.performance.ozon.ru',
        hasClientId: true,
        hasClientSecret: true,
        status: 'active',
        note: 'new note',
      },
    });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('Ozon Performance API');
    expect(screen.getByLabelText('Client Secret')).toHaveValue('••••••••••');
    fireEvent.change(screen.getByLabelText('备注（选填）'), { target: { value: 'new note' } });
    fireEvent.click(screen.getByRole('button', { name: '保存接口资料' }));

    await waitFor(() => expect(mocks.savePerformanceAccount).toHaveBeenCalledTimes(1));
    const [payload] = mocks.savePerformanceAccount.mock.calls[0];
    expect(payload).toMatchObject({
      id: 'performance-active',
      clientId: 'saved@advertising.performance.ozon.ru',
      note: 'new note',
    });
    expect(payload).not.toHaveProperty('clientSecret');
    expect(payload).not.toHaveProperty('status');
  });

  it('saves a normal platform profile and deletes it through verified account removal', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [
        {
          id: 'platform-custom', integrationType: 'tool', platformName: '内部工具接口',
          apiType: '工具服务', authMode: '本机配置', configStatus: '已保存', note: 'old note',
        },
      ],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockResolvedValue({
      profile: {
        id: 'platform-custom', integrationType: 'tool', platformName: '内部工具接口',
        apiType: '工具服务', authMode: '本机配置', configStatus: '已保存', note: 'new note',
      },
    });
    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('内部工具接口');
    fireEvent.change(screen.getByLabelText('备注（选填）'), { target: { value: 'new note' } });
    fireEvent.click(screen.getByRole('button', { name: '保存接口资料' }));
    await waitFor(() =>
      expect(mocks.saveIntegrationProfile).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'platform-custom', note: 'new note' }),
        { timeoutMs: 30000 }
      )
    );
    fireEvent.click(screen.getByRole('button', { name: '删除当前接口' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [owner, options] = accountRemovalMocks.openAccountRemoval.mock.calls[0];
    expect(owner).toEqual({ ownerType: 'integration_profile', ownerId: 'platform-custom' });
    expect(mocks.deleteIntegrationProfile).not.toHaveBeenCalled();

    await options.onCompleted({ completed: true });
    await waitFor(() => expect(screen.queryByDisplayValue('内部工具接口')).not.toBeInTheDocument());
    expect(browserStorage.getItem(storageKey)).toBeNull();
  });

  it('saves the current platform page when the dialog footer requests Save', async () => {
    const config = buildPlatformConfig();
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: 'platform-custom', integrationType: 'tool', platformName: '内部工具接口',
        apiType: '工具服务', authMode: '本机配置', configStatus: '已保存', note: 'old note',
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    mocks.saveIntegrationProfile.mockResolvedValue({
      profile: {
        id: 'platform-custom', integrationType: 'tool', platformName: '内部工具接口',
        apiType: '工具服务', authMode: '本机配置', configStatus: '已保存', note: 'footer saved',
      },
    });

    const { rerender } = render(
      <StructuredSettingsLayout config={config} actionNote="" onAction={() => {}} saveRequestId={0} />
    );
    await screen.findByDisplayValue('内部工具接口');
    fireEvent.change(screen.getByLabelText('备注（选填）'), { target: { value: 'footer saved' } });

    rerender(<StructuredSettingsLayout config={config} actionNote="" onAction={() => {}} saveRequestId={1} />);

    await waitFor(() =>
      expect(mocks.saveIntegrationProfile).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'platform-custom', note: 'footer saved' }),
        { timeoutMs: 30000 }
      )
    );
  });

  it('routes a persisted Performance account with an arbitrary id through verified account removal', async () => {
    const performanceId = 'platformApi-local-arbitrary-id';
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: performanceId,
        name: '任意 ID Performance 账号',
        hasClientId: true,
        hasClientSecret: true,
        status: 'inactive',
      }],
    });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /任意 ID Performance 账号/u }));
    await screen.findByDisplayValue('任意 ID Performance 账号');
    fireEvent.click(screen.getByRole('button', { name: '删除当前接口' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [owner, options] = accountRemovalMocks.openAccountRemoval.mock.calls[0];
    expect(owner).toEqual({ ownerType: 'promotion_account', ownerId: performanceId });
    expect(mocks.deleteIntegrationProfile).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('任意 ID Performance 账号')).toBeInTheDocument();

    await options.onCompleted({ completed: true });
    await waitFor(() => expect(screen.queryByDisplayValue('任意 ID Performance 账号')).not.toBeInTheDocument());
  });

  it('does not let a persisted platform row change into another account owner type in place', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: 'locked-platform-profile',
        integrationType: 'tool',
        platformName: '已保存内部工具',
        apiType: '工具服务',
        authMode: '本机配置',
        configStatus: '已保存',
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('已保存内部工具');
    const typeInput = screen.getByLabelText('外部服务');
    expect(typeInput).toHaveValue('tool');
    fireEvent.change(typeInput, { target: { value: 'ozon-performance' } });

    expect(typeInput).toHaveValue('tool');
    expect(screen.getByText('已保存接口不能直接改成另一种账号类型；请新增接口，或先删除当前配置。')).toBeInTheDocument();
    expect(mocks.savePerformanceAccount).not.toHaveBeenCalled();
  });

  it('cleans both persisted owner rows when an old platform id collides across profile and Performance tables', async () => {
    const collidingId = 'legacy-colliding-platform-id';
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{
        id: collidingId,
        integrationType: 'tool',
        platformName: '旧平台配置',
        apiType: '工具服务',
        authMode: '本机配置',
        configStatus: '已保存',
      }],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: collidingId,
        name: '同编号 Performance 账号',
        hasClientId: true,
        hasClientSecret: true,
        status: 'inactive',
      }],
    });

    render(<StructuredSettingsLayout config={buildPlatformConfig()} actionNote="" onAction={() => {}} />);

    await screen.findByDisplayValue('同编号 Performance 账号');
    fireEvent.click(screen.getByRole('button', { name: '删除当前接口' }));
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(1));
    const [performanceOwner, performanceOptions] = accountRemovalMocks.openAccountRemoval.mock.calls[0];
    expect(performanceOwner).toEqual({ ownerType: 'promotion_account', ownerId: collidingId });

    await act(async () => {
      await performanceOptions.onCompleted({ completed: true });
    });
    expect(screen.getByDisplayValue('同编号 Performance 账号')).toBeInTheDocument();
    expect(screen.getByText('检测到同编号的旧平台配置，正在继续清理第二条残留。')).toBeInTheDocument();
    await waitFor(() => expect(accountRemovalMocks.openAccountRemoval).toHaveBeenCalledTimes(2));
    const [profileOwner, profileOptions] = accountRemovalMocks.openAccountRemoval.mock.calls[1];
    expect(profileOwner).toEqual({ ownerType: 'integration_profile', ownerId: collidingId });

    await act(async () => {
      await profileOptions.onCompleted({ completed: true });
    });
    await waitFor(() => expect(screen.queryByDisplayValue('同编号 Performance 账号')).not.toBeInTheDocument());
  });
});
