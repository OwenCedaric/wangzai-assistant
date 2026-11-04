import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PointsPackagePaymentDialog } from './PointsPackagePaymentDialog.jsx';

function alipayModel() {
  return {
    selectedPackage: {
      id: 7,
      name: '专业积分包',
      price: 19.9,
      points: 20000,
      estimatedLinks: 25,
      paymentProviders: ['alipay'],
    },
    paymentMethod: 'alipay',
    paymentError: '',
    paymentState: 'awaiting',
    checkout: {
      order: { order_no: 'LC202608050000001' },
      payment: {
        provider: 'alipay',
        code_url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay',
        qr_code_url: null,
      },
    },
    closePayment: vi.fn(),
    completeDevelopmentPayment: vi.fn(),
  };
}

describe('PointsPackagePaymentDialog', () => {
  it('embeds the official Alipay cashier instead of encoding its gateway URL again', () => {
    const model = alipayModel();
    render(<PointsPackagePaymentDialog model={model} />);

    expect(screen.getByText('打开支付宝扫码付款')).toBeInTheDocument();
    const frame = screen.getByTitle('支付宝官方付款二维码');
    expect(frame).toHaveAttribute(
      'src',
      'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay'
    );
    expect(frame).toHaveAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin');
    expect(screen.queryByTestId('payment-qrcode')).not.toBeInTheDocument();
    expect(screen.queryByText('支付宝付款二维码已生成')).not.toBeInTheDocument();
    expect(screen.queryByText('LC202608050000001')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开支付宝收银台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /生成/u })).not.toBeInTheDocument();
  });

  it('shows only an in-place loader while the automatically created order is pending', () => {
    const model = { ...alipayModel(), checkout: null, paymentState: 'creating' };
    render(<PointsPackagePaymentDialog model={model} />);

    expect(screen.queryByTitle('支付宝官方付款二维码')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /生成|创建订单|收银台/u })).not.toBeInTheDocument();
  });
});
