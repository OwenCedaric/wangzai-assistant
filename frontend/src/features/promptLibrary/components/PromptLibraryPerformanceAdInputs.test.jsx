import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPerformanceAccounts: vi.fn(),
  readPerformanceOverview: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  listPerformanceAccounts: mocks.listPerformanceAccounts,
  readPerformanceOverview: mocks.readPerformanceOverview,
}));

import { PERFORMANCE_AD_USAGE_LABELS } from '../services/smartToolPerformanceAdDataService.js';
import { PromptLibraryPerformanceAdInputs } from './PromptLibraryPerformanceAdInputs.jsx';

const tool = {
  id: 'ozon-ad-analyzer',
  title: 'Ozon 广告分析',
  skillProfile: {
    usageInputs: [
      PERFORMANCE_AD_USAGE_LABELS.account,
      PERFORMANCE_AD_USAGE_LABELS.campaign,
      PERFORMANCE_AD_USAGE_LABELS.dateRange,
    ],
  },
};

function Harness({ onChangeValue = () => {} }) {
  const [values, setValues] = React.useState({
    [PERFORMANCE_AD_USAGE_LABELS.account]: '',
    [PERFORMANCE_AD_USAGE_LABELS.campaign]: '',
    [PERFORMANCE_AD_USAGE_LABELS.dateRange]: '7',
  });
  const handleChangeValue = (label, value) => {
    onChangeValue(label, value);
    setValues((current) => ({ ...current, [label]: value }));
  };
  return (
    <PromptLibraryPerformanceAdInputs
      selectedPrompt={tool}
      values={values}
      onChangeValue={handleChangeValue}
    />
  );
}

describe('PromptLibraryPerformanceAdInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'older-account',
          title: '旧推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'latest-account',
          title: '主推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
        {
          id: 'missing-secret',
          title: '密钥不完整账号',
          hasClientId: true,
          hasClientSecret: false,
          updatedAt: '2026-07-31T00:00:00.000Z',
        },
      ],
    });
    mocks.readPerformanceOverview.mockImplementation(async (payload) => ({
      ok: true,
      campaigns: payload.values.accountId === 'older-account'
        ? [{ id: 'old-campaign', title: '旧账号计划', statusLabel: '已暂停' }]
        : [
          { id: 'campaign-1', title: '夏季连衣裙', statusLabel: '运行中' },
          { id: 'campaign-2', title: '冬季羽绒服', statusLabel: '已暂停' },
        ],
    }));
  });

  it('打开后自动选择最近配置账号，并联动读取真实广告计划', async () => {
    const onChangeValue = vi.fn();
    render(<Harness onChangeValue={onChangeValue} />);

    const accountSelect = screen.getByRole('combobox', { name: '推广账号' });
    await waitFor(() => expect(accountSelect).toHaveTextContent('主推广账号'));
    await waitFor(() => expect(mocks.readPerformanceOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ accountId: 'latest-account', readDepth: 'fast' }),
      }),
      expect.any(Object),
    ));
    expect(onChangeValue).toHaveBeenCalledWith(PERFORMANCE_AD_USAGE_LABELS.account, 'latest-account');
    expect(screen.queryByText('密钥不完整账号')).not.toBeInTheDocument();

    await screen.findByText('已读取 2 个计划，可直接选择。');
    const campaignSelect = screen.getByRole('combobox', { name: '广告计划' });
    expect(campaignSelect).toHaveTextContent('全部计划');
    expect(screen.getByText('广告计划', { selector: 'label' })).toHaveAttribute('data-shrink', 'true');

    fireEvent.mouseDown(campaignSelect);
    const planOptions = screen.getAllByRole('option');
    expect(planOptions[0]).toHaveTextContent('全部计划');
    fireEvent.click(screen.getByRole('option', { name: '夏季连衣裙 · 运行中' }));
    expect(campaignSelect).toHaveTextContent('夏季连衣裙');

    fireEvent.mouseDown(accountSelect);
    fireEvent.click(screen.getByRole('option', { name: '旧推广账号' }));
    await screen.findByText('已读取 1 个计划，可直接选择。');
    expect(campaignSelect).toHaveTextContent('全部计划');
    expect(mocks.readPerformanceOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ accountId: 'older-account', readDepth: 'fast' }),
      }),
      expect.any(Object),
    );
  });

  it('没有可用账号时明确提示去小齿轮配置，不退回手工输入框', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{ id: 'missing-secret', hasClientId: true, hasClientSecret: false }],
    });

    render(<Harness />);

    await screen.findByText('请先在小齿轮中配置 Ozon Performance API。');
    expect(screen.getByRole('combobox', { name: '推广账号' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: '广告计划' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('textbox', { name: /推广账号|广告计划/u })).not.toBeInTheDocument();
    expect(mocks.readPerformanceOverview).not.toHaveBeenCalled();
  });
});
