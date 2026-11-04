import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import { formatMoney, formatPoints } from '../lib/pointsPackagePricing.js';
import { resolvePointsPaymentCheckoutUrl } from '../services/pointsPackagePaymentService.js';

const paymentMethods = Object.freeze({
  alipay: { label: '支付宝', mark: '支', color: '#1677ff' },
  wechat: { label: '微信支付', mark: '微', color: '#19ad6f' },
  development: { label: '开发模拟支付', mark: '测', color: '#a06e2f' },
});

export function PointsPackagePaymentDialog({ model }) {
  const packageItem = model.selectedPackage;
  const payment = model.checkout?.payment;
  const qrCodeUrl = String(payment?.qr_code_url || '');
  const checkoutUrl = resolvePointsPaymentCheckoutUrl(payment);
  const alipayWebCheckout = payment?.provider === 'alipay' && Boolean(checkoutUrl);
  const paymentQrValue = alipayWebCheckout ? '' : qrCodeUrl;
  const providers = (packageItem?.paymentProviders || []).filter((id) => paymentMethods[id]);
  const busy = model.paymentState === 'creating';
  const succeeded = model.paymentState === 'succeeded';

  return (
    <Dialog
      open={Boolean(packageItem)}
      onClose={model.closePayment}
      fullWidth
      maxWidth="sm"
      keepMounted
      PaperProps={{ sx: { color: '#343238', bgcolor: '#fffdfb', border: '1px solid rgba(52,50,56,.11)' } }}
    >
      {packageItem ? (
        <>
          <DialogTitle sx={{ pr: 6, fontSize: 22, fontWeight: 900 }}>
            确认购买 {packageItem.name}
            <Typography
              component="span"
              sx={{ display: 'block', mt: 0.5, color: '#6d6870', fontSize: 12, fontWeight: 500 }}
            >
              订单、支付确认和积分到账全部由管理系统处理
            </Typography>
            <IconButton
              onClick={model.closePayment}
              aria-label="关闭支付弹窗"
              sx={{ position: 'absolute', top: 12, right: 12 }}
            >
              <CloseRounded />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 0.8, mb: 2 }}>
              {[
                ['支付金额', formatMoney(packageItem.price)],
                ['到账积分', formatPoints(packageItem.points)],
                ['预计链接', `${packageItem.estimatedLinks} 条`],
              ].map(([label, value]) => (
                <Box
                  key={label}
                  sx={{ p: 1.35, border: '1px solid rgba(52,50,56,.11)', borderRadius: 1.5, bgcolor: '#faf7f1' }}
                >
                  <Typography sx={{ color: '#6d6870', fontSize: 10 }}>{label}</Typography>
                  <Typography sx={{ mt: 0.45, fontSize: 16, fontWeight: 900 }}>{value}</Typography>
                </Box>
              ))}
            </Box>
            <Typography sx={{ mb: 0.7, color: '#343238', fontSize: 13, fontWeight: 900 }}>支付方式</Typography>
            <Stack direction="row" spacing={1}>
              {providers.map((id) => {
                const item = paymentMethods[id];
                const selected = model.paymentMethod === id;
                return (
                  <Button
                    key={id}
                    component="div"
                    aria-pressed={selected}
                    aria-disabled="true"
                    sx={{
                      flex: 1,
                      justifyContent: 'flex-start',
                      gap: 1,
                      p: 1.25,
                      border: `1px solid ${selected ? item.color : 'rgba(52,50,56,.11)'}`,
                      borderRadius: 1.5,
                      bgcolor: selected ? `${item.color}12` : '#faf7f1',
                      color: '#343238',
                      pointerEvents: 'none',
                    }}
                  >
                    <Box
                      sx={{
                        display: 'grid',
                        placeItems: 'center',
                        width: 34,
                        height: 34,
                        borderRadius: 1,
                        color: '#fff',
                        bgcolor: item.color,
                        fontSize: 13,
                        fontWeight: 900,
                      }}
                    >
                      {item.mark}
                    </Box>
                    <Box sx={{ textAlign: 'left' }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 900 }}>{item.label}</Typography>
                      <Typography sx={{ color: '#6d6870', fontSize: 10 }}>
                        {id === 'alipay' ? '打开支付宝扫码付款' : id === 'development' ? '本机联调' : '扫码支付'}
                      </Typography>
                    </Box>
                  </Button>
                );
              })}
            </Stack>
            {!providers.length ? (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                管理后台尚未启用可用的支付渠道。
              </Alert>
            ) : null}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                alignItems: 'center',
                mt: 1.8,
                p: 2,
                border: '1px solid rgba(52,50,56,.11)',
                borderRadius: 1.75,
                bgcolor: '#faf7f1',
              }}
            >
              <Box
                sx={{
                  display: 'grid',
                  placeItems: 'center',
                  justifySelf: 'center',
                  width: 220,
                  height: 220,
                  border: '8px solid #fff',
                  borderRadius: 1.25,
                  color: '#a06e2f',
                  bgcolor: '#fff2d9',
                }}
              >
                {succeeded ? (
                  <CheckCircleRounded sx={{ color: '#168766', fontSize: 72 }} />
                ) : alipayWebCheckout ? (
                  <Box
                    component="iframe"
                    data-testid="alipay-checkout-frame"
                    title="支付宝官方付款二维码"
                    src={checkoutUrl}
                    referrerPolicy="no-referrer"
                    sandbox="allow-forms allow-scripts allow-same-origin"
                    scrolling="no"
                    sx={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      border: 0,
                      bgcolor: '#fff',
                    }}
                  />
                ) : paymentQrValue ? (
                  <Box
                    data-testid="payment-qrcode"
                    aria-label="付款二维码"
                    sx={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', bgcolor: '#fff' }}
                  >
                    <QRCodeSVG value={paymentQrValue} size={196} level="H" title="付款二维码" />
                  </Box>
                ) : busy ? (
                  <CircularProgress sx={{ color: '#a06e2f' }} />
                ) : null}
              </Box>
            </Box>
            {model.paymentError ? (
              <Alert severity="error" sx={{ mt: 1.5, fontSize: 11 }}>
                {model.paymentError}
              </Alert>
            ) : null}
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2.5 }}>
            <Button onClick={model.closePayment} sx={{ color: '#6d6870' }}>
              {succeeded ? '完成' : '返回'}
            </Button>
            {model.paymentMethod === 'development' && model.paymentState === 'awaiting' ? (
              <Button
                variant="contained"
                onClick={model.completeDevelopmentPayment}
                sx={{ bgcolor: '#a06e2f', '&:hover': { bgcolor: '#7b5220' } }}
              >
                模拟支付完成
              </Button>
            ) : null}
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
