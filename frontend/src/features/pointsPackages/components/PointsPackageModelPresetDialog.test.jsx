import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PointsPackageModelPresetDialog } from './PointsPackageModelPresetDialog.jsx';

function createModel() {
  return {
    modelPresetOpen: true,
    modelPresetLoading: false,
    modelPresetSaving: false,
    modelPresetError: '',
    modelPresetGroups: [
      {
        capabilityKind: 'text',
        label: '文本模型',
        enabledModels: ['gpt-5.6-sol'],
        defaultModel: 'gpt-5.6-sol',
        models: [
          {
            modelCode: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            apiStatus: 'available',
            configuredApiCount: 5,
            availableApiCount: 5,
            busyApiCount: 0,
            coolingApiCount: 0,
            pricedCapabilityCount: 4,
            totalCapabilityCount: 4,
            canEnable: true,
            unavailableReason: '',
          },
          {
            modelCode: 'gpt-5.6-terra',
            displayName: 'GPT-5.6-Terra',
            apiStatus: 'available',
            configuredApiCount: 5,
            availableApiCount: 5,
            busyApiCount: 0,
            coolingApiCount: 0,
            pricedCapabilityCount: 4,
            totalCapabilityCount: 4,
            canEnable: true,
            unavailableReason: '',
          },
        ],
      },
      {
        capabilityKind: 'image',
        label: '图片模型',
        enabledModels: ['gpt-image-2'],
        defaultModel: 'gpt-image-2',
        models: [
          {
            modelCode: 'gpt-image-2',
            displayName: 'GPT Image 2',
            apiStatus: 'available',
            configuredApiCount: 5,
            availableApiCount: 4,
            busyApiCount: 1,
            coolingApiCount: 0,
            pricedCapabilityCount: 2,
            totalCapabilityCount: 2,
            canEnable: true,
            unavailableReason: '',
          },
        ],
      },
    ],
    closeModelPreset: vi.fn(),
    toggleModelPreset: vi.fn(),
    setDefaultPresetModel: vi.fn(),
    saveModelPreset: vi.fn(),
  };
}

describe('PointsPackageModelPresetDialog', () => {
  it('shows only management-enabled models and keeps save action without key secrets', () => {
    const model = createModel();
    render(<PointsPackageModelPresetDialog model={model} />);
    expect(screen.getByText('模型预设与生效 API')).toBeInTheDocument();
    expect(screen.getByText(/不按 Ozon 店铺拆分/)).toBeInTheDocument();
    expect(screen.getAllByText('5/5 个 API')).toHaveLength(2);
    expect(screen.getByText('4/5 个 API')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.6-Terra')).toBeInTheDocument();
    const terraToggle = screen.getByRole('checkbox', { name: '启用 GPT-5.6-Terra' });
    expect(terraToggle).not.toBeChecked();
    fireEvent.click(terraToggle);
    expect(model.toggleModelPreset).toHaveBeenCalledWith('text', 'gpt-5.6-terra');
    expect(screen.queryByText('GPT Image 2 Adobe')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存并立即生效' }));
    expect(model.saveModelPreset).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('sk-');
  });
});
