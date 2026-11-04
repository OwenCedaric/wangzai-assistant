import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeLogisticsPricingSettings } from '../../../services/logisticsPricingSettingsStore.js';
import { LogisticsPricingSettingsCard } from './LogisticsPricingSettingsCard.jsx';

const runtimeMocks = vi.hoisted(() => ({
  loadLogisticsPricingSettings: vi.fn(),
  readSavedLogisticsPricingSettings: vi.fn(),
  saveLogisticsPricingSettings: vi.fn(),
}));

vi.mock('../../../services/logisticsPricingSettingsRuntime.js', () => runtimeMocks);

describe('LogisticsPricingSettingsCard', () => {
  beforeEach(() => {
    const settings = normalizeLogisticsPricingSettings(null);
    runtimeMocks.readSavedLogisticsPricingSettings.mockReturnValue(settings);
    runtimeMocks.loadLogisticsPricingSettings.mockResolvedValue(settings);
    runtimeMocks.saveLogisticsPricingSettings.mockImplementation((value) => value);
  });

  afterEach(() => {
    document.body.removeAttribute('style');
    vi.clearAllMocks();
  });

  it('opens every selector without changing the body scrollbar width', async () => {
    document.body.style.overflow = 'auto';
    document.body.style.paddingRight = '9px';
    render(<LogisticsPricingSettingsCard shops={[]} />);
    await waitFor(() => expect(runtimeMocks.loadLogisticsPricingSettings).toHaveBeenCalledTimes(1));

    const selectors = screen.getAllByRole('combobox');
    expect(selectors).toHaveLength(4);
    expect(document.querySelector('.logistics-pricing-fields')?.children).toHaveLength(4);
    expect(document.querySelector('.logistics-pricing-footer')).toBeInTheDocument();
    expect(document.querySelector('.logistics-pricing-actions')?.querySelectorAll('button')).toHaveLength(2);
    for (const selector of selectors) {
      fireEvent.mouseDown(selector);
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      expect(document.body.style.overflow).toBe('auto');
      expect(document.body.style.paddingRight).toBe('9px');
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    }
  });

  it('shows one canonical option per Ozon shop and migrates a legacy shop override to its Client ID', async () => {
    const settings = normalizeLogisticsPricingSettings({
      shopSelections: {
        'shop-1': { providerId: 'cel', market: 'RU', serviceLevel: 'express' },
      },
    });
    runtimeMocks.readSavedLogisticsPricingSettings.mockReturnValue(settings);
    runtimeMocks.loadLogisticsPricingSettings.mockResolvedValue(settings);

    render(<LogisticsPricingSettingsCard shops={[
      { id: 'shop-1', shopAlias: 'Ozon 1店', clientId: '4616153' },
      { id: 'shop-2', shopAlias: 'Ozon 2店', clientId: '4067387' },
    ]} />);
    await waitFor(() => expect(runtimeMocks.loadLogisticsPricingSettings).toHaveBeenCalledTimes(1));

    const selectors = screen.getAllByRole('combobox');
    fireEvent.mouseDown(selectors[0]);
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '全局默认（所有用户/店铺）',
      'Ozon 1店（4616153）',
      'Ozon 2店（4067387）',
    ]);
    expect(screen.queryByText(/^(店铺|账号) ·/u)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'Ozon 1店（4616153）' }));
    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveTextContent('CEL'));
    fireEvent.click(screen.getByRole('button', { name: /保存此范围/u }));

    expect(runtimeMocks.saveLogisticsPricingSettings).toHaveBeenCalledWith(expect.objectContaining({
      shopSelections: {},
      accountSelections: expect.objectContaining({
        4616153: expect.objectContaining({ providerId: 'cel', serviceLevel: 'express' }),
      }),
    }));
  });
});
