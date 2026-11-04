import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WechatAssistantSettingsPanel from './WechatAssistantSettingsPanel.jsx';

vi.mock('../../promptLibrary/services/smartToolModelService.js', () => ({
  loadSmartToolModelState: vi.fn(async () => ({ interfaces: [] })),
  listSmartToolModelOptions: vi.fn(() => [{
    id: 'saved-api-1::custom-chat-model',
    accountId: 'saved-api-1',
    model: 'custom-chat-model',
    displayName: 'Custom Chat Model',
    usageScene: '客服文本模型',
    ready: true,
  }]),
}));

function runtimeStatus(overrides = {}) {
  return {
    ok: true,
    runtimeAvailable: true,
    runtimeVersion: '2026.7.1-2',
    pluginVersion: '2.4.6',
    configured: false,
    settings: {
      assistantName: '旺崽微信助理',
      assistantStyle: 'brief',
      modelSource: 'builtin-points',
      modelAccountId: '',
      modelName: 'gpt-5.6-terra',
      toolAccessMode: 'read-only',
      allowedOperationActions: [],
    },
    gateway: { phase: 'stopped', reachable: false, port: 18791, error: '' },
    modelChannel: { phase: 'ready', source: 'builtin-points', model: 'gpt-5.6-terra', strategy: 'managed-safe-failover' },
    channelRecovery: { phase: 'ready', attempt: 0, safety: 'never-retry-unknown-model-or-write-outcomes' },
    points: { required: true, phase: 'ready', balancePoints: 100, reservedPoints: 0, availablePoints: 100, checkedAt: '2026-08-24T00:00:00.000Z', error: '' },
    login: { phase: 'idle', message: '', qrDataUrl: '', verifyCodeRequired: false },
    accounts: { count: 0, labels: [] },
    readonlyToolAvailable: true,
    operationToolAvailable: true,
    logs: [],
    ...overrides,
  };
}

async function selectOption(label, optionName) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

describe('WechatAssistantSettingsPanel', () => {
  beforeEach(() => {
    window.wangzaiDesktop = {
      wechatAssistant: {
        command: vi.fn(async (input) => {
          if (input.command === 'save-settings') {
            return { ok: true, status: runtimeStatus({ configured: true }) };
          }
          if (input.command === 'start') {
            return { ok: true, status: runtimeStatus({ configured: true, gateway: { phase: 'running', reachable: true, port: 18791, error: '' } }) };
          }
          return runtimeStatus();
        }),
      },
    };
  });

  it('shows the bundled OpenClaw and Tencent WeChat runtime state', async () => {
    render(<WechatAssistantSettingsPanel />);

    expect(screen.getByRole('heading', { name: '微信助理' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/2026\.7\.1-2/u)).toBeInTheDocument());
    expect(screen.getByText('2.4.6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检测内置版' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '保存并启用内置版' })).toBeEnabled();
    expect(screen.getByText('可用积分 100')).toBeInTheDocument();
    expect(screen.getByText('连接正常')).toBeInTheDocument();
    expect(screen.getByText('同模型安全切换')).toBeInTheDocument();
    expect(screen.getByTestId('wechat-assistant-runtime-logs')).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看日志' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收起日志' })).not.toBeInTheDocument();
  });

  it('blocks activation immediately when the built-in points account is exhausted', async () => {
    window.wangzaiDesktop.wechatAssistant.command.mockResolvedValue(runtimeStatus({
      points: { required: true, phase: 'depleted', balancePoints: 0, reservedPoints: 0, availablePoints: 0, checkedAt: '2026-08-24T00:00:00.000Z', error: '当前账户可用积分为 0。' },
    }));
    render(<WechatAssistantSettingsPanel />);
    expect(await screen.findByText('积分已耗尽')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并启用内置版' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '检查配置' })).toBeEnabled();
  });

  it('saves the built-in points model without collecting an API key in the page', async () => {
    const { rerender } = render(<WechatAssistantSettingsPanel saveRequestId={0} />);
    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalled());

    await selectOption('内置模型', '高性能模型（能力更强）');
    rerender(<WechatAssistantSettingsPanel saveRequestId={1} />);

    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'save-settings',
      settings: expect.objectContaining({ modelSource: 'builtin-points', modelAccountId: '', modelName: 'gpt-5.6-sol' }),
    })));
    expect(screen.queryByLabelText('接口密钥')).not.toBeInTheDocument();
    expect(screen.queryByText(/配置已安全保存/u)).not.toBeInTheDocument();
  });

  it('saves settings and starts the bundled runtime from the primary action', async () => {
    render(<WechatAssistantSettingsPanel />);
    await waitFor(() => expect(screen.getByText(/2026\.7\.1-2/u)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '保存并启用内置版' }));

    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'save-settings',
      settings: expect.objectContaining({ modelSource: 'builtin-points', modelName: 'gpt-5.6-terra' }),
    })));
    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith({ command: 'start' }));
    expect(screen.queryByText('已切换到旺崽助手内置小龙虾。')).not.toBeInTheDocument();
  });

  it('does not render model-check success banners above the settings workspace', async () => {
    window.wangzaiDesktop.wechatAssistant.command.mockImplementation(async (input) => {
      if (input.command === 'save-settings') return { ok: true, status: runtimeStatus({ configured: true }) };
      if (input.command === 'test-model') return { ok: true, message: '模型配置可用，本次检测不扣积分。', status: runtimeStatus({ configured: true }) };
      return runtimeStatus();
    });
    render(<WechatAssistantSettingsPanel />);
    await waitFor(() => expect(screen.getByText(/2026\.7\.1-2/u)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '检查配置' }));
    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith({ command: 'test-model' }));

    expect(screen.queryByText(/模型配置可用/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads a verified saved API model without exposing credential fields', async () => {
    const { rerender } = render(<WechatAssistantSettingsPanel saveRequestId={0} />);
    await waitFor(() => expect(screen.getByText(/2026\.7\.1-2/u)).toBeInTheDocument());
    await selectOption('模型来源', '已有模型接口 · 不扣积分');
    await waitFor(() => expect(screen.getByRole('combobox', { name: '已保存的接口与模型' })).toHaveTextContent('已保存接口 1 · 客服文本模型'));
    expect(screen.queryByText('Custom Chat Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('接口密钥')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('接口地址')).not.toBeInTheDocument();
    rerender(<WechatAssistantSettingsPanel saveRequestId={1} />);
    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'save-settings',
      settings: expect.objectContaining({
        modelSource: 'saved-api',
        modelAccountId: 'saved-api-1',
        modelName: 'custom-chat-model',
      }),
    })));
  });

  it('reuses the stable MUI settings select without locking or shifting the page', async () => {
    render(<WechatAssistantSettingsPanel />);
    const originalOverflow = document.body.style.overflow;
    const runtimeSelect = screen.getByRole('combobox', { name: '运行版本' });
    const styleSelect = screen.getByRole('combobox', { name: '默认回复风格' });

    expect(runtimeSelect.tagName).toBe('DIV');
    expect(styleSelect).toHaveAttribute('aria-haspopup', 'listbox');
    fireEvent.mouseDown(styleSelect);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe(originalOverflow);
    fireEvent.click(screen.getByRole('option', { name: '严格审计' }));
    expect(styleSelect).toHaveTextContent('严格审计');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe(originalOverflow);
  });

  it('lets the user authorize business modifications that take effect directly', async () => {
    const { rerender } = render(<WechatAssistantSettingsPanel saveRequestId={0} />);
    await waitFor(() => expect(screen.getByText(/2026\.7\.1-2/u)).toBeInTheDocument());

    await selectOption('小龙虾操作权限', '允许操作与修改（直接生效）');
    expect(screen.getByText('授权操作直接生效')).toBeInTheDocument();
    expect(await screen.findByText('设置小龙虾具体权限')).toBeInTheDocument();
    expect(screen.getByTestId('wechat-permission-groups')).toHaveStyle({ display: 'flex', flexDirection: 'column' });
    fireEvent.click(screen.getByRole('checkbox', { name: '修改商品价格' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '修改商品库存' }));
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(screen.getAllByText(/已授权 2 项/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/命中这些操作后直接执行/u)).not.toBeInTheDocument();
    rerender(<WechatAssistantSettingsPanel saveRequestId={1} />);

    await waitFor(() => expect(window.wangzaiDesktop.wechatAssistant.command).toHaveBeenCalledWith(expect.objectContaining({
      command: 'save-settings',
      settings: expect.objectContaining({
        toolAccessMode: 'direct-write',
        allowedOperationActions: [
          'products:product.updatePrice',
          'products:product.updateStock',
        ],
      }),
    })));
  });

  it('shows only Chinese summaries for raw gateway diagnostics and pricing activation failures', async () => {
    window.wangzaiDesktop.wechatAssistant.command.mockResolvedValue(runtimeStatus({
      modelChannel: {
        phase: 'error',
        source: 'builtin-points',
        model: 'gpt-5.6-terra',
        strategy: 'managed-safe-failover',
        code: 'MODEL_POINTS_PRICE_UNAVAILABLE',
        error: '503 所选模型没有当前功能的有效积分价格',
      },
      logs: [
        '18:30:02 [gateway] embedded run agent end: isError=true model=gpt-5.6-terra error=503 所选模型没有当前功能的有效积分价格',
        '18:30:02 [gateway] [model-fallback/decision] model fallback decision: candidate_failed',
      ],
    }));
    render(<WechatAssistantSettingsPanel />);

    expect(await screen.findByText('积分价格未启用')).toBeInTheDocument();
    const diagnostics = screen.getByTestId('wechat-assistant-runtime-logs');
    expect(diagnostics).toHaveTextContent('当前模型暂未启用积分价格');
    expect(diagnostics).toHaveTextContent('本次没有调用模型，也不会扣积分');
    expect(diagnostics.textContent).not.toMatch(/[A-Za-z]{3,}/u);
    expect(screen.queryByText(/FailoverError|model fallback|gateway/iu)).not.toBeInTheDocument();
  });
});
