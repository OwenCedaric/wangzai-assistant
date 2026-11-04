import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLicenseRuntime } from '../../licensing/services/licenseCenterClient.js';
import {
  beginPointsCheckout,
  loadPointPackageCatalog,
  loadPointsAccount,
} from '../services/pointsPackagePaymentService.js';
import { loadPointsModelPresets } from '../services/pointsPackageModelPresetService.js';
import { usePointsPackagesModel } from './usePointsPackagesModel.jsx';

vi.mock('../../licensing/services/licenseCenterClient.js', () => ({
  getLicenseRuntime: vi.fn(),
}));

vi.mock('../services/pointsPackagePaymentService.js', () => ({
  beginPointsCheckout: vi.fn(),
  completePointsDevelopmentCheckout: vi.fn(),
  createPointsOrderIdempotencyKey: vi.fn(() => 'points-test-key'),
  loadPointPackageCatalog: vi.fn(),
  loadPointsAccount: vi.fn(),
  pointOrderIsFulfilled: vi.fn(() => false),
  queryPointsCheckout: vi.fn(),
  readPointsOrder: vi.fn(),
}));

vi.mock('../services/pointsPackageModelPresetService.js', () => ({
  createModelPresetDraft: vi.fn((catalog) =>
    (catalog?.groups || []).map((group) => ({
      capabilityKind: group.capabilityKind,
      enabledModels: [...group.enabledModels],
      defaultModel: group.defaultModel,
    }))
  ),
  loadPointsModelPresets: vi.fn(),
  savePointsModelPresets: vi.fn(),
}));

describe('usePointsPackagesModel management catalog sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLicenseRuntime.mockResolvedValue({ projectCode: 'wangzai_desktop' });
    loadPointsModelPresets.mockResolvedValue({
      groups: [
        {
          capabilityKind: 'text',
          label: '文本模型',
          enabledModels: ['gpt-5.6-sol'],
          defaultModel: 'gpt-5.6-sol',
          models: [],
        },
        {
          capabilityKind: 'image',
          label: '图片模型',
          enabledModels: ['gpt-image-2'],
          defaultModel: 'gpt-image-2',
          models: [],
        },
      ],
    });
  });

  it('quietly reloads packages when the desktop window regains focus', async () => {
    loadPointsAccount.mockResolvedValueOnce({
      packages: [],
      wallet: { balance_points: 99471 },
      ledger: [],
    });
    loadPointPackageCatalog.mockResolvedValueOnce([{ id: 15, name: '专业月卡', points: 41895 }]);

    const { result } = renderHook(() => usePointsPackagesModel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.packages).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.packages).toHaveLength(1));
    expect(result.current.packages[0]).toMatchObject({ id: 15, name: '专业月卡', points: 41895 });
    expect(loadPointsAccount).toHaveBeenCalledTimes(1);
    expect(loadPointPackageCatalog).toHaveBeenCalledTimes(1);
    expect(loadPointsModelPresets).toHaveBeenCalledTimes(1);
  });

  it('creates the user-bound order immediately when a package is selected', async () => {
    loadPointsAccount.mockResolvedValueOnce({
      packages: [
        {
          id: 15,
          name: '专业月卡',
          points: 41895,
          paymentProviders: ['alipay'],
        },
      ],
      wallet: { balance_points: 0 },
      ledger: [],
    });
    beginPointsCheckout.mockResolvedValueOnce({
      order: { id: 99, order_no: 'LC-QR-TEST' },
      payment: {
        provider: 'alipay',
        code_url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay',
      },
    });

    const { result } = renderHook(() => usePointsPackagesModel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.openPayment(15));

    expect(result.current.paymentState).toBe('awaiting');
    expect(result.current.checkout?.payment?.provider).toBe('alipay');
    expect(beginPointsCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        packageItem: expect.objectContaining({ id: 15 }),
        provider: 'alipay',
        idempotencyKey: 'points-test-key',
      })
    );
    expect(result.current.startPayment).toBeUndefined();
  });

  it('ignores a repeated package click while the first order is still being created', async () => {
    let finishCheckout;
    loadPointsAccount.mockResolvedValueOnce({
      packages: [{ id: 15, name: '专业月卡', points: 41895, paymentProviders: ['alipay'] }],
      wallet: { balance_points: 0 },
      ledger: [],
    });
    beginPointsCheckout.mockImplementationOnce(
      () => new Promise((resolve) => { finishCheckout = resolve; })
    );

    const { result } = renderHook(() => usePointsPackagesModel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.openPayment(15);
      void result.current.openPayment(15);
    });
    expect(beginPointsCheckout).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishCheckout({ order: { id: 99 }, payment: { provider: 'alipay' } });
    });
    expect(result.current.paymentState).toBe('awaiting');
  });
});
