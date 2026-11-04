import AddRounded from '@mui/icons-material/AddRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';

import { formatOzonPrice } from '../../../entities/product/productPriceRules.jsx';
import { LazyHoverImagePreview } from '../../../shared/ui/ImagePreview.jsx';
import { loadAutoOrderProductList } from '../services/purchaseAutoOrderProductListService.js';
import { purchaseSkuBindingErrorMessage } from '../services/purchaseSkuBindingService.js';
import { PurchaseSkuBindingPanel } from './PurchaseSkuBindingPanel.jsx';

function formatUpdatedAt(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function formatMetricRange(range, formatter) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return '—';
  const minimum = formatter(range.min);
  const maximum = formatter(range.max);
  return Math.abs(range.max - range.min) < 0.005 ? minimum : `${minimum}–${maximum}`;
}

function formatCnyRange(range) {
  return formatMetricRange(range, (value) => formatOzonPrice(value, 'CNY'));
}

function formatPercentRange(range) {
  return formatMetricRange(range, (value) => `${value.toFixed(2)}%`);
}

function OzonProductImage({ item }) {
  if (!item.ozonImageUrl) return <Typography color="text.disabled">—</Typography>;
  return (
    <LazyHoverImagePreview
      className="auto-order-ozon-image-hover"
      previewClassName="sales-order-image-preview"
      imageUrl={item.ozonImageUrl}
      alt={item.ozonTitle || 'Ozon商品图片'}
    >
      <Box className="auto-order-ozon-image-thumb">
        <Box
          component="img"
          src={item.ozonImageUrl}
          alt={item.ozonTitle || 'Ozon商品图片'}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      </Box>
    </LazyHoverImagePreview>
  );
}

function BoundStatusIcon() {
  return (
    <Box
      role="img"
      aria-label="已绑定"
      title="已绑定"
      sx={{
        width: 28,
        height: 28,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '50%',
        bgcolor: 'success.main',
        color: 'common.white',
        boxShadow: '0 3px 10px rgba(18, 183, 106, 0.2)',
      }}
    >
      <CheckRounded sx={{ fontSize: 19 }} />
    </Box>
  );
}

export function PurchaseAutoOrderProductList({ isActive = true, loadProducts = loadAutoOrderProductList }) {
  const [bindings, setBindings] = React.useState([]);
  const [summary, setSummary] = React.useState({ total: 0, boundCount: 0, pendingSkuCount: 0 });
  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [dialogBinding, setDialogBinding] = React.useState(undefined);
  const dialogOpen = dialogBinding !== undefined;

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      const document = await loadProducts();
      setBindings(Array.isArray(document?.items) ? document.items : []);
      setSummary({
        total: Number(document?.total) || 0,
        boundCount: Number(document?.boundCount) || 0,
        pendingSkuCount: Number(document?.pendingSkuCount) || 0,
      });
    } catch (error) {
      setBindings([]);
      setErrorMessage(purchaseSkuBindingErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [loadProducts]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    void refresh();
    return undefined;
  }, [isActive, refresh]);

  const handleSaved = (result) => {
    setDialogBinding(undefined);
    void refresh();
    globalThis.dispatchEvent?.(new CustomEvent('wangzai:auto-order-binding-saved', {
      detail: {
        shopId: result?.binding?.shopId || '',
        ozonSkuIds: (result?.binding?.pairs || []).map((pair) => pair.ozonSkuId).filter(Boolean),
      },
    }));
  };

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1.5}>
        <Box>
          <Typography variant="h5" fontWeight={800}>商品列表</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            已保存货源链接的商品都会显示；未完成 SKU 对应的商品可继续完善。
          </Typography>
          {summary.total ? (
            <Typography variant="caption" color="text.secondary">
              共 {summary.total} 个商品 · 已完成 {summary.boundCount} 个 · 待完善 SKU {summary.pendingSkuCount} 个
            </Typography>
          ) : null}
        </Box>
        <Button variant="contained" startIcon={<AddRounded />} onClick={() => setDialogBinding(null)}>
          添加商品
        </Button>
      </Stack>

      {errorMessage ? <Alert severity="warning">{errorMessage}</Alert> : null}
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: '6px', overflow: 'hidden' }}>
        <Table
          size="small"
          sx={{
            width: '100%',
            tableLayout: 'fixed',
            '& .MuiTableCell-root': {
              boxSizing: 'border-box',
              px: 0.85,
              py: 1.2,
              fontSize: '0.82rem',
              lineHeight: 1.3,
              verticalAlign: 'middle',
            },
            '& .MuiTableRow-head': {
              height: 46,
            },
            '& .MuiTableBody-root .MuiTableRow-root': {
              height: 96,
            },
            '& .MuiTableCell-head': {
              py: 1.3,
              fontSize: '0.76rem',
              fontWeight: 800,
              whiteSpace: 'nowrap',
            },
            '& .MuiTableCell-body .MuiTypography-root': {
              fontSize: 'inherit',
              lineHeight: 'inherit',
            },
            '& .MuiTableCell-body .MuiTypography-caption': {
              fontSize: '0.72rem',
            },
            '& .MuiTableCell-body .MuiChip-root': {
              height: 24,
              borderRadius: '6px',
              fontSize: '0.72rem',
            },
            '& .MuiTableCell-body .MuiButton-root': {
              minWidth: 0,
              px: 0.5,
              fontSize: '0.72rem',
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
            },
          }}
        >
          <TableHead>
            <TableRow>
              <TableCell width={58} align="center">产品图片</TableCell>
              <TableCell width="19%">Ozon商品</TableCell>
              <TableCell width={54} align="center">店铺</TableCell>
              <TableCell width={64} align="center">销售价</TableCell>
              <TableCell width={72} align="center">绑定SKU价</TableCell>
              <TableCell width={62} align="center">价差</TableCell>
              <TableCell width={64} align="center" title="按（销售价－绑定SKU采购价）÷销售价计算">毛利率</TableCell>
              <TableCell width="21%">货源商品</TableCell>
              <TableCell width={58} align="center">货源平台</TableCell>
              <TableCell width={58} align="center">SKU绑定</TableCell>
              <TableCell width={78} align="center">更新时间</TableCell>
              <TableCell width={78} align="center">状态</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {bindings.map((binding) => (
              <TableRow key={binding.id || binding.ozonUrl} hover>
                <TableCell align="center"><OzonProductImage item={binding} /></TableCell>
                <TableCell sx={{ overflow: 'hidden' }}>
                  <Typography fontWeight={700} sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>
                    {binding.ozonTitle || 'Ozon商品'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {binding.ozonUrl}
                  </Typography>
                </TableCell>
                <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>{binding.shopName || 'Ozon店铺'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {formatOzonPrice(binding.salePrice, binding.saleCurrency)}
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {formatCnyRange(binding.bindingPriceMetrics?.sourcePrice)}
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap', color: (binding.bindingPriceMetrics?.difference?.min ?? 0) >= 0 ? 'success.main' : 'error.main' }}>
                  {formatCnyRange(binding.bindingPriceMetrics?.difference)}
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap', color: (binding.bindingPriceMetrics?.grossMargin?.min ?? 0) >= 0 ? 'success.main' : 'error.main' }}>
                  {formatPercentRange(binding.bindingPriceMetrics?.grossMargin)}
                </TableCell>
                <TableCell sx={{ overflow: 'hidden' }}>
                  <Typography fontWeight={700} sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>
                    {binding.sourceTitle || '货源商品'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {binding.sourceUrl}
                  </Typography>
                </TableCell>
                <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>{binding.sourcePlatform || '—'}</TableCell>
                <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>{binding.pairs.length ? `${binding.pairs.length} 组` : '待完善'}</TableCell>
                <TableCell align="center">{formatUpdatedAt(binding.updatedAt)}</TableCell>
                <TableCell align="center">
                  <Stack spacing={0.75} alignItems="center">
                    {binding.bindingStatus === 'bound' ? (
                      <BoundStatusIcon />
                    ) : (
                      <Chip size="small" color="warning" label="待完善SKU" sx={{ borderRadius: '6px' }} />
                    )}
                    <Button size="small" onClick={() => setDialogBinding(binding)}>
                      {binding.bindingStatus === 'bound' ? '重新绑定' : '完善绑定'}
                    </Button>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
            {!loading && !bindings.length ? (
              <TableRow>
                <TableCell colSpan={12}>
                  <Stack alignItems="center" spacing={1.25} sx={{ py: 7 }}>
                    <Inventory2Outlined color="disabled" sx={{ fontSize: 44 }} />
                    <Typography fontWeight={700}>还没有保存货源链接的商品</Typography>
                    <Typography variant="body2" color="text.secondary">点击右上角“添加商品”，绑定 Ozon 主链接和采购链接。</Typography>
                    <Button variant="outlined" startIcon={<AddRounded />} onClick={() => setDialogBinding(null)}>添加商品</Button>
                  </Stack>
                </TableCell>
              </TableRow>
            ) : null}
            {loading ? (
              <TableRow><TableCell colSpan={12} align="center" sx={{ py: 7 }}>正在读取商品列表…</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogBinding(undefined)}
        fullWidth
        maxWidth="xl"
        slotProps={{
          paper: {
            sx: {
              height: 'calc(100vh - 24px)',
              maxHeight: 'calc(100vh - 24px)',
              borderRadius: '6px',
              overflow: 'hidden',
            },
          },
        }}
      >
        <DialogTitle component="div">
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
            <Box>
              <Typography variant="h5" component="div" fontWeight={800}>
                {dialogBinding ? '完善商品绑定' : '添加商品'}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                读取订单商品下的全部Ozon SKU，并把每个SKU ID精确绑定到一个货源SKU ID。
              </Typography>
            </Box>
            <IconButton aria-label="关闭添加商品弹窗" onClick={() => setDialogBinding(undefined)} sx={{ mt: -0.5, mr: -0.75 }}>
              <CloseRounded />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 2, overflow: 'hidden', minHeight: 0 }}>
          {dialogOpen ? (
            <PurchaseSkuBindingPanel
              isActive
              initialOzonUrl={dialogBinding?.ozonUrl || ''}
              initialSourceUrl={dialogBinding?.sourceUrl || ''}
              scope={{
                shopId: dialogBinding?.shopId || '',
                productId: dialogBinding?.productId || '',
                offerId: dialogBinding?.offerId || '',
                sku: dialogBinding?.sku || '',
              }}
              onSaved={handleSaved}
              showSavedBindings={false}
              fitViewport
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
