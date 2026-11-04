import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./PromptLibraryPerformanceAdInputs.jsx', () => ({
  PromptLibraryPerformanceAdInputs: () => <div>推广账号与广告计划</div>,
}));

import { PromptLibraryStandardRun } from './PromptLibraryStandardRun.jsx';

const selectedPrompt = {
  id: 'ozon-ad-analyzer',
  title: 'Ozon 广告分析',
  goal: '读取真实广告数据并执行 Skill 分析',
  skillProfile: { modelCapability: 'text-generation', usageInputs: ['统计范围'] },
  promptConfig: { defaultModelId: 'auto' },
};

const modelOptions = [
  {
    id: 'auto',
    accountId: 'default-account',
    model: 'gpt-5.5',
    ready: true,
    statusLabel: '默认已配置',
  },
  {
    id: 'second-account::gpt-5.6-sol',
    accountId: 'second-account',
    model: 'gpt-5.6-sol',
    ready: true,
    statusLabel: '已配置',
  },
];

describe('PromptLibraryStandardRun performance Skill', () => {
  it('显示分析模型并把所选模型交给广告 Skill 完整运行', () => {
    const onRunDraft = vi.fn();
    render(<PromptLibraryStandardRun
      selectedPrompt={selectedPrompt}
      usageInputs={['统计范围']}
      values={{ 统计范围: '7' }}
      performanceAdEnabled
      browserDataEnabled
      textModelOptions={modelOptions}
      onRunDraft={onRunDraft}
    />);

    const modelSelect = screen.getByRole('combobox', { name: '分析模型' });
    expect(modelSelect).toBeVisible();
    fireEvent.mouseDown(modelSelect);
    fireEvent.click(screen.getByRole('option', { name: 'Chat-GPT-5.6-Sol · 已配置' }));
    fireEvent.click(screen.getByRole('button', { name: '读取并分析广告' }));

    expect(onRunDraft).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'second-account',
      model: 'gpt-5.6-sol',
      ready: true,
    }));
  });

  it('最终只展示模型生成的中文经营报告，不再展示底层接口错误列表', () => {
    render(<PromptLibraryStandardRun
      selectedPrompt={selectedPrompt}
      usageInputs={['统计范围']}
      values={{ 统计范围: '7' }}
      performanceAdEnabled
      browserDataEnabled
      textModelOptions={modelOptions}
      draft={{
        result: {
          status: 'ready',
          statusLabel: 'Ozon 广告 Skill 分析完成',
          viewType: 'performance-ads',
          performanceAdInsight: {
            status: 'ready',
            model: 'gpt-5.6-sol',
            generatedAt: '2026-07-31T12:00:00.000Z',
            report: {
              title: '广告经营诊断',
              executiveSummary: '统计不足，暂时不要调整预算。',
              marketAssessment: '先补齐点击和花费数据。',
              keyFindings: [{ title: '关键指标暂无数据', evidence: '当前没有返回点击和花费', action: '稍后重新读取' }],
              opportunities: [],
              risks: [],
              actionPlan: [{ priority: '高', title: '重新读取', evidence: '当前数据不足', action: '重新分析' }],
              dataGaps: [],
            },
          },
          sections: [{ title: '数据完整性', rows: ['/api/client/campaign/1/objects: campaign not found'] }],
        },
      }}
    />);

    expect(screen.getByRole('heading', { level: 1, name: '广告经营诊断' })).toBeVisible();
    expect(screen.getByText('统计不足，暂时不要调整预算。')).toBeVisible();
    expect(document.body).not.toHaveTextContent('/api/client/campaign');
    expect(document.body).not.toHaveTextContent('campaign not found');
  });
});
