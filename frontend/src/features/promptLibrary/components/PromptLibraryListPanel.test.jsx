import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { formatSmartToolModelDisplayName } from '../services/smartToolModelService.js';
import { createSmartToolMeta } from '../lib/smartToolRuntime.js';
import { PromptLibraryListPanel } from './PromptLibraryListPanel.jsx';

describe('PromptLibraryListPanel model display names', () => {
  it.each([
    ['gpt-5.5', 'Chat-GPT-5.5'],
    ['gpt-5.6-sol', 'Chat-GPT-5.6-Sol'],
    ['gpt-5.6-terra', 'Chat-GPT-5.6-Terra'],
    ['gpt-image-2', 'Chat-GPT-Image-2'],
    ['openai/gpt-5.6-sol', 'Chat-GPT-5.6-Sol'],
  ])('formats %s as %s', (modelId, expected) => {
    expect(formatSmartToolModelDisplayName(modelId)).toBe(expected);
  });

  it('shows a clear fallback when no model is configured', () => {
    expect(formatSmartToolModelDisplayName('未配置')).toBe('未配置模型');
  });

  it('labels an installed script Skill as waiting for an adapter', () => {
    const onRunPrompt = vi.fn();
    const item = {
      id: 'prompt-custom-script',
      title: '外部查询脚本',
      goal: '读取外部商品数据',
      scene: 'custom',
      skillProfile: { installType: 'skill-md', runType: 'external-or-script' },
      promptConfig: {},
    };
    render(
      <PromptLibraryListPanel
        prompts={[{ ...item, toolMeta: createSmartToolMeta(item) }]}
        keyword=""
        scene="all"
        scenes={[{ value: 'all', label: '全部' }]}
        onKeywordChange={vi.fn()}
        onSceneChange={vi.fn()}
        onRunPrompt={onRunPrompt}
        onEditPrompt={vi.fn()}
      />
    );

    expect(screen.getByText('等待适配器')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看适配要求' }));
    expect(onRunPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
  });

  it('shows a direct delete button only for a user-installed Skill', () => {
    const onDeletePrompt = vi.fn();
    const installedItem = {
      id: 'prompt-installed-skill',
      title: '我的 Skill',
      goal: '本地工具',
      scene: 'custom',
      skillProfile: {
        runType: 'local-ai-preview',
        installType: 'github-skill',
        sourceHash: 'hash-1',
      },
      promptConfig: {},
    };
    render(
      <PromptLibraryListPanel
        prompts={[{ ...installedItem, toolMeta: createSmartToolMeta(installedItem) }]}
        keyword=""
        scene="all"
        scenes={[{ value: 'all', label: '全部' }]}
        onKeywordChange={vi.fn()}
        onSceneChange={vi.fn()}
        onRunPrompt={vi.fn()}
        onEditPrompt={vi.fn()}
        onDeletePrompt={onDeletePrompt}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onDeletePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: installedItem.id }));
  });

  it('does not show generic execution state on a native Skill card', () => {
    const nativeItem = {
      id: 'ozon-skill-1688-channel-shopdata-get',
      title: 'Ozon 报表读取与分析',
      goal: '读取经营报表',
      scene: 'report',
      status: '可用',
      skillProfile: {},
      promptConfig: {},
      toolMeta: {
        availabilityLabel: '能用',
        availabilityTone: 'success',
        primaryActionLabel: '使用功能',
        apiCapabilityMatch: {
          executionPlan: { totalCount: 1, executableCount: 0, unsupportedCount: 1 },
        },
      },
    };

    render(
      <PromptLibraryListPanel
        prompts={[nativeItem]}
        keyword=""
        scene="all"
        scenes={[{ value: 'all', label: '全部' }]}
        onKeywordChange={vi.fn()}
        onSceneChange={vi.fn()}
        onRunPrompt={vi.fn()}
        onEditPrompt={vi.fn()}
      />
    );

    expect(screen.getByText('能用')).toBeVisible();
    expect(screen.queryByText(/执行 0\/1/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });
});
