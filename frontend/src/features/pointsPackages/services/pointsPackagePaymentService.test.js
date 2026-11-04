import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeDevelopmentPayment,
  createStoreOrder,
  getPointWallet,
  listPointLedger,
  listPointPackages,
  startOrderPayment,
} from '../../licensing/services/licenseCenterClient.js';
import {
  beginPointsCheckout,
  createPointsOrderIdempotencyKey,
  loadPointPackageCatalog,
  loadPointsAccount,
  normalizePointPackage,
  pointOrderIsFulfilled,
  resolvePointsPaymentCheckoutUrl,
} from './pointsPackagePaymentService.js';

vi.mock('../../licensing/services/licenseCenterClient.js', () => ({
  completeDevelopmentPayment: vi.fn(),
  createStoreOrder: vi.fn(),
  getPointWallet: vi.fn(),
  getStoreOrder: vi.fn(),
  listPointPackages: vi.fn(),
  listPointLedger: vi.fn(),
  queryStoreOrderPayment: vi.fn(),
  startOrderPayment: vi.fn(),
}));

describe('points package payment service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes only server-issued point package fields', () => {
    expect(
      normalizePointPackage({
        id: 7,
        name: '专业月卡',
        sale_price_cent: 3990,
        points_amount: 41895,
        validity_days: 30,
        featured: true,
        payment_providers: ['alipay', 'development'],
        project_code: 'wangzai_desktop',
      })
    ).toMatchObject({
      id: 7,
      name: '专业月卡',
      price: 39.9,
      priceCent: 3990,
      points: 41895,
      validityDays: 30,
      featured: true,
      paymentProviders: ['alipay', 'development'],
    });
  });

  it('loads the package catalog and isolated wallet together', async () => {
    listPointPackages.mockResolvedValue([{ id: 1, name: '体验包', sale_price_cent: 990, points_amount: 10395 }]);
    getPointWallet.mockResolvedValue({ balance_points: 1234, project_code: 'wangzai_desktop' });
    listPointLedger.mockResolvedValue({ items: [{ id: 9, event_type: 'admin_credit', delta_points: 1234 }] });

    const result = await loadPointsAccount({ projectCode: 'wangzai_desktop' });

    expect(result.packages[0]).toMatchObject({ id: 1, price: 9.9, points: 10395 });
    expect(result.wallet.balance_points).toBe(1234);
    expect(result.ledger).toEqual([{ id: 9, event_type: 'admin_credit', delta_points: 1234 }]);
    expect(listPointLedger).toHaveBeenCalledWith({ projectCode: 'wangzai_desktop' }, { page: 1, pageSize: 20 });
  });

  it('reloads only the public package catalog for management-side changes', async () => {
    listPointPackages.mockResolvedValue([{ id: 15, name: '专业月卡', sale_price_cent: 3990, points_amount: 41895 }]);

    const catalog = await loadPointPackageCatalog({ projectCode: 'wangzai_desktop' });

    expect(catalog).toEqual([expect.objectContaining({ id: 15, name: '专业月卡', price: 39.9, points: 41895 })]);
    expect(getPointWallet).not.toHaveBeenCalled();
    expect(listPointLedger).not.toHaveBeenCalled();
  });

  it('uses one idempotent order before requesting the payment provider', async () => {
    createStoreOrder.mockResolvedValue({ id: 91, order_no: 'WZ-91' });
    startOrderPayment.mockResolvedValue({ provider: 'development', code_url: 'development://WZ-91' });

    const result = await beginPointsCheckout({
      runtime: { projectCode: 'wangzai_desktop' },
      packageItem: { id: 7 },
      provider: 'development',
      idempotencyKey: 'points-7-fixed',
    });

    expect(createStoreOrder).toHaveBeenCalledWith({ projectCode: 'wangzai_desktop' }, 7, 'points-7-fixed');
    expect(startOrderPayment).toHaveBeenCalledWith(91, 'development');
    expect(result.payment.code_url).toContain('WZ-91');
  });

  it('accepts only fulfilled point orders with a positive credit', async () => {
    expect(
      pointOrderIsFulfilled({ status: 'fulfilled', plan_kind: 'points', fulfillment: { points_credited: 10395 } })
    ).toBe(true);
    expect(
      pointOrderIsFulfilled({ status: 'fulfilled', plan_kind: 'license', fulfillment: { points_credited: 10395 } })
    ).toBe(false);
    expect(
      pointOrderIsFulfilled({ status: 'paid', plan_kind: 'points', fulfillment: { points_credited: 10395 } })
    ).toBe(false);
    completeDevelopmentPayment.mockResolvedValue({ ok: true });
  });

  it('creates bounded keys so repeated clicks can reuse the same server order', () => {
    const key = createPointsOrderIdempotencyKey(88);
    expect(key.startsWith('points-88-')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('accepts only official production or sandbox Alipay gateway URLs for the QR code', () => {
    const production = {
      provider: 'alipay',
      code_url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=abc',
    };
    const sandbox = {
      provider: 'alipay',
      code_url: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do?method=alipay.trade.page.pay',
    };

    expect(resolvePointsPaymentCheckoutUrl(production)).toContain('openapi.alipay.com/gateway.do');
    expect(resolvePointsPaymentCheckoutUrl(sandbox)).toContain('openapi-sandbox.dl.alipaydev.com');
    expect(resolvePointsPaymentCheckoutUrl({ ...production, code_url: 'http://openapi.alipay.com/gateway.do' })).toBe(
      ''
    );
    expect(
      resolvePointsPaymentCheckoutUrl({ ...production, code_url: 'https://openapi.alipay.com.evil.test/gateway.do' })
    ).toBe('');
    expect(resolvePointsPaymentCheckoutUrl({ ...production, code_url: 'https://openapi.alipay.com/other' })).toBe('');
    expect(
      resolvePointsPaymentCheckoutUrl({
        ...production,
        code_url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.precreate',
      })
    ).toBe('');
  });
});
