import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  listModelApiAccounts: vi.fn(),
  saveProfileSetting: vi.fn(),
  loadIntegrationState: vi.fn(),
}));

vi.mock('../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  listModelApiAccounts: mocks.listModelApiAccounts,
  saveProfileSetting: mocks.saveProfileSetting,
}));

vi.mock('./services/smartToolIntegrationProfileService.js', () => ({
  loadSmartToolIntegrationState: mocks.loadIntegrationState,
}));

import { PromptLibraryPage } from './PromptLibraryPage.jsx';

describe('PromptLibraryPage image-generation test skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.loadIntegrationState.mockResolvedValue({
      integrationTypes: [],
      hasThirdPartyToolAccount: false,
    });
    mocks.listModelApiAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'image-interface',
          baseUrl: 'https://image.example/v1',
          hasApiKey: true,
          discoveryVerified: true,
          defaultModel: 'gpt-image-2',
          capabilities: ['image-edit', 'image-generation', 'text-generation'],
          availableModels: [
            { id: 'gpt-5-mini', capabilities: ['text-generation'] },
            { id: 'gpt-image-2', capabilities: ['image-edit', 'image-generation'] },
          ],
          isDefault: true,
        },
        {
          id: 'text-interface',
          baseUrl: 'https://text.example/v1',
          hasApiKey: true,
          discoveryVerified: true,
          defaultModel: 'gpt-5.5',
          capabilities: ['text-generation'],
          availableModels: [{ id: 'gpt-5.5', capabilities: ['text-generation'] }],
        },
      ],
    });
  });

  it('uses the configured image model and shows a four-image comparison workspace', async () => {
    render(<PromptLibraryPage />);

    const title = await screen.findByText('Ozon 商品图生成');
    const card = title.closest('article');
    expect(card).toBeTruthy();

    await waitFor(() => expect(card).toHaveTextContent('Chat-GPT-Image-2'));
    expect(card).not.toHaveTextContent('当前使用模型');
    expect(card).toHaveTextContent('Chat-GPT-5.5');
    expect(card).not.toHaveTextContent('跟随默认');
    expect(card).not.toHaveTextContent('配置 2 /');
    const plannerModelChip = within(card).getByText('Chat-GPT-5.5');
    const imageModelChip = within(card).getByText('Chat-GPT-Image-2');
    const purposeChip = within(card).getByText('Ozon 商品图方案规划');
    expect(plannerModelChip.compareDocumentPosition(imageModelChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(imageModelChip.compareDocumentPosition(purposeChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: '编辑 Skill' }));
    const editor = await screen.findByRole('dialog');
    expect(editor).toHaveTextContent('设置工具规则');
    expect(editor).toHaveTextContent('全局规则 + 图片规则 + 属性规则');
    expect(editor).toHaveTextContent('全局 Skill');
    expect(editor).toHaveTextContent('图片位置规则');
    expect(editor).toHaveTextContent('属性规则');
    expect(within(editor).queryByText('模型和输入')).not.toBeInTheDocument();
    expect(within(editor).queryByRole('combobox', { name: '分析 / 文案模型' })).not.toBeInTheDocument();
    expect(within(editor).queryByRole('combobox', { name: '图片生成模型' })).not.toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('tab', { name: '全局 Skill' }));
    expect(within(editor).getByRole('textbox', { name: '角色与任务规则内容' })).toBeVisible();
    expect(editor.querySelector('details')).not.toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('tab', { name: '图片位置规则' }));
    expect(editor).toHaveTextContent('绑定商品主图第 1 张');
    expect(within(editor).getAllByLabelText('这张图负责什么', { selector: 'input' })[0]).toHaveValue(
      'SKU 专属主卖点图'
    );
    fireEvent.click(within(editor).getByRole('button', { name: '新增主图规则' }));
    expect(editor).toHaveTextContent('绑定商品主图第 9 张');
    expect(within(editor).getAllByRole('button', { name: '删除' })).toHaveLength(9);
    fireEvent.click(within(editor).getByRole('tab', { name: '属性规则' }));
    expect(within(editor).getByRole('textbox', { name: '优化目标属性规则' }).value).toContain(
      '当前已存在的 Ozon 商品资料'
    );
    fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(within(card).getByRole('button', { name: '使用功能' }));
    const runDialog = await screen.findByRole('dialog', {}, { timeout: 15000 });
    expect(runDialog.closest('.prompt-library-run-dialog')).toHaveClass('is-image-generation');
    expect(runDialog.closest('.prompt-library-run-dialog')).not.toHaveClass('is-product-content-workbench');
    expect(runDialog).not.toHaveTextContent('SKILL 目标');
    fireEvent.change(within(runDialog).getByLabelText('商品图片或商品 SKU'), {
      target: { value: 'https://img.example/product.jpg' },
    });
    fireEvent.change(within(runDialog).getByLabelText('SKU 信息'), {
      target: { value: '黑色 500ml' },
    });
    fireEvent.change(within(runDialog).getByLabelText('目标场景（可选）'), {
      target: { value: '户外露营' },
    });
    await waitFor(() => expect(runDialog).toHaveTextContent('主图模块'));
    const historyButton = within(runDialog).getByRole('button', { name: '生图历史' });
    const modeSwitchButton = within(runDialog).getByRole('button', { name: '编辑文案与属性' });
    const closeButton = within(runDialog).getByRole('button', { name: '关闭使用功能' });
    expect(historyButton.compareDocumentPosition(modeSwitchButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modeSwitchButton.compareDocumentPosition(closeButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runDialog).not.toHaveTextContent('商品图片对比');
    expect(runDialog).toHaveTextContent('主图模块');
    expect(runDialog).toHaveTextContent('详情图模块');
    expect(within(runDialog).getByText('商品资料智能填写')).not.toBeVisible();
    expect(runDialog).toHaveTextContent('1 + 0');
    expect(runDialog).toHaveTextContent('生成 1 张主图');
    expect(runDialog).toHaveTextContent('请选择详情图');
    expect(runDialog).not.toHaveTextContent('SKU 专属主图 Prompt');
    expect(runDialog).not.toHaveTextContent('7 张共享详情图规划');

    fireEvent.click(modeSwitchButton);
    expect(within(runDialog).getByText('商品资料智能填写')).toBeVisible();
    expect(within(runDialog).getByText('主图模块')).not.toBeVisible();
    expect(within(runDialog).getByText('详情图模块')).not.toBeVisible();
    expect(within(runDialog).getByLabelText('商品图片或商品 SKU')).toHaveValue('https://img.example/product.jpg');
    expect(within(runDialog).getByLabelText('SKU 信息')).toHaveValue('黑色 500ml');

    fireEvent.click(within(runDialog).getByRole('button', { name: '返回图片工作台' }));
    expect(within(runDialog).getByText('主图模块')).toBeVisible();
    expect(within(runDialog).getByText('详情图模块')).toBeVisible();
    expect(within(runDialog).getByText('商品资料智能填写')).not.toBeVisible();
  }, 30000);
});
