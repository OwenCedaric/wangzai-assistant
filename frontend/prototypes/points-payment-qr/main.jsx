import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PointsPackagePaymentDialog } from '../../src/features/pointsPackages/components/PointsPackagePaymentDialog.jsx';
import '../../src/styles.css';

const theme = createTheme({
  typography: {
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
});

const previewModel = {
  selectedPackage: {
    id: 12,
    name: '体验包',
    price: 9.9,
    points: 10395,
    estimatedLinks: 11,
    paymentProviders: ['alipay'],
  },
  paymentMethod: 'alipay',
  paymentError: '',
  paymentState: 'awaiting',
  checkout: {
    order: { order_no: 'LC202608060000001' },
    payment: {
      provider: 'alipay',
      code_url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&preview=1',
      qr_code_url: null,
    },
  },
  closePayment() {},
  completeDevelopmentPayment() {},
};

document.body.style.margin = '0';
document.body.style.minHeight = '100vh';
document.body.style.background = '#e9e5de';

createRoot(document.getElementById('root')).render(
  <ThemeProvider theme={theme}>
    <PointsPackagePaymentDialog model={previewModel} />
  </ThemeProvider>
);
