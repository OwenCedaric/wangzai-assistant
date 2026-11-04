import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
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

import {
  getOzonOrderDisplayStatusLabel,
  getOzonOrderStatusTextColor,
  isOzonAwaitingDeliveryRawStatus,
} from '../../../entities/order/orderStatusRules.jsx';
import {
  automaticOrderActionLabels,
  automaticOrderSections,
} from '../services/automaticOrderWorkflowService.js';
import { PurchaseSkuBindingPanel } from './PurchaseSkuBindingPanel.jsx';

const SECTION_COPY = Object.freeze({
  [automaticOrderSections.autoOrder]: {
    title: '真自动拍单',
    description: '只处理已完成货源 SKU 精确绑定的真实订单，付款成功后回传采购平台、金额和采购单号。',
  },
  [automaticOrderSections.stock]: {
    title: '一键备货',
    description: '批量提交所选 Ozon 订单备货；每单独立校验状态并防止重复提交。',
  },
  [automaticOrderSections.forecast]: {
    title: '一键预报',
    description: '批量检查面单并创建跨境巴士预报；失败订单保留原状态，可以单独重试。',
  },
});

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '—';
}

function formatOzonOrderStatus(value) {
  return getOzonOrderDisplayStatusLabel(value);
}

function actionState(row, section, taskStates) {
  return taskStates[`${section}:${row.id}`] || null;
}

function stateLabel(row, section, taskStates) {
  const task = actionState(row, section, taskStates);
  if (task?.status === 'running') return { label: '处理中', color: 'info', icon: <CircularProgress size={14} /> };
  if (task?.status === 'paused') return { label: '已暂停', color: 'warning', icon: <ErrorOutlineRounded fontSize="small" /> };
  if (task?.status === 'failed') return { label: '处理失败', color: 'error', icon: <ErrorOutlineRounded fontSize="small" /> };
  if (task?.status === 'completed' || row.workflow?.[section] === 'completed') {
    return { label: '已完成', color: 'success', icon: <CheckRounded fontSize="small" /> };
  }
  if (row.workflow?.[section] === 'ready') return { label: '可以处理', color: 'primary' };
  if (section === automaticOrderSections.autoOrder && !row.allBound) return { label: '货源未绑定', color: 'warning' };
  if (section === automaticOrderSections.autoOrder && row.autoOrderSupported === false) return { label: '平台暂不支持', color: 'warning' };
  if (section === automaticOrderSections.autoOrder && row.purchaseManagementCanPurchase === false) return { label: '拍单管理已拦截', color: 'warning' };
  if (section === automaticOrderSections.forecast && !isOzonAwaitingDeliveryRawStatus(row.rawStatus)) {
    return { label: '等待面单状态', color: 'default' };
  }
  return { label: '当前状态不可处理', color: 'default' };
}

function productBindingText(row) {
  const product = row.products[0];
  if (!product) return { product: '未返回商品', sku: '未返回', source: '未绑定' };
  const binding = product.exactBinding;
  return {
    product: product.name,
    sku: product.sku || '未返回',
    source: binding
      ? `${binding.binding.sourcePlatform || '货源'} · ${binding.pair.sourceSkuName || binding.pair.sourceSkuId}`
      : '未绑定',
    sourcePrice: binding?.pair?.sourcePrice,
  };
}

export function automaticOrderBindingTarget(row = {}) {
  const products = Array.isArray(row.products) ? row.products : [];
  const product = products.find((item) => !item.exactBinding) || products[0] || null;
  if (!product) return null;
  const sku = String(product.sku || product.ozonSku || '').trim();
  const productId = String(product.productId || '').trim();
  const publicSku = [sku, productId].find((value) => /^\d{5,20}$/u.test(value)) || '';
  return {
    rowId: row.id,
    posting: row.posting,
    productName: product.name || 'Ozon商品',
    ozonUrl: publicSku ? `https://www.ozon.ru/product/${publicSku}/` : '',
    sourceUrl: String(product.savedSourceLink?.link || '').trim(),
    scope: {
      shopId: String(row.shopId || '').trim(),
      productId,
      offerId: String(product.offerId || '').trim(),
      sku,
    },
  };
}

export function AutomaticOrderBatchPage({ section, workflow }) {
  const [bindingTarget, setBindingTarget] = React.useState(null);
  const copy = SECTION_COPY[section];
  const selected = workflow.selectionBySection[section] || new Set();
  const readyRows = workflow.rows.filter((row) => row.workflow?.[section] === 'ready');
  const allReadySelected = readyRows.length > 0 && readyRows.every((row) => selected.has(row.id));
  const selectedCount = workflow.rows.filter((row) => selected.has(row.id)).length;

  return (
    <Stack spacing={1.5}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', md: 'center' }} gap={1.5}>
        <Box>
          <Typography variant="h5" fontWeight={800}>{copy.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.4 }}>{copy.description}</Typography>
          <Typography variant="caption" color="text.secondary">
            共 {workflow.rows.length} 单 · 可处理 {readyRows.length} 单 · 已选择 {selectedCount} 单
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<RefreshRounded />}
            disabled={workflow.loading}
            onClick={() => workflow.refresh({ forceRefresh: true })}
          >
            刷新订单
          </Button>
          <Button
            variant="contained"
            startIcon={<PlayArrowRounded />}
            disabled={!selectedCount || workflow.loading}
            onClick={() => workflow.executeSelected(section)}
          >
            {automaticOrderActionLabels[section]}
          </Button>
        </Stack>
      </Stack>

      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: '6px', overflow: 'hidden' }}>
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow sx={{ height: 46 }}>
              <TableCell padding="checkbox" align="center">
                <Checkbox
                  size="small"
                  checked={allReadySelected}
                  indeterminate={!allReadySelected && readyRows.some((row) => selected.has(row.id))}
                  disabled={!readyRows.length}
                  onChange={() => workflow.selectAllReady(section)}
                />
              </TableCell>
              <TableCell width="16%">Ozon订单</TableCell>
              <TableCell width="9%">店铺</TableCell>
              <TableCell width="20%">订单商品</TableCell>
              <TableCell width="18%">货源SKU</TableCell>
              <TableCell width="9%">采购金额</TableCell>
              <TableCell width="12%">采购单号</TableCell>
              <TableCell width="10%">Ozon状态</TableCell>
              <TableCell width="10%" align="center">处理状态</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {workflow.rows.map((row) => {
              const ready = row.workflow?.[section] === 'ready';
              const binding = productBindingText(row);
              const state = stateLabel(row, section, workflow.taskStates);
              const task = actionState(row, section, workflow.taskStates);
              return (
                <TableRow key={row.id} hover sx={{ height: 88 }}>
                  <TableCell padding="checkbox" align="center">
                    <Checkbox
                      size="small"
                      checked={selected.has(row.id)}
                      disabled={!ready}
                      onChange={() => workflow.toggleSelection(section, row.id)}
                      inputProps={{ 'aria-label': `选择订单 ${row.posting}` }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography fontWeight={800} noWrap title={row.posting}>{row.posting}</Typography>
                    <Typography variant="caption" color="text.secondary">{row.paymentTime || '付款时间未返回'}</Typography>
                  </TableCell>
                  <TableCell>{row.shopName}</TableCell>
                  <TableCell sx={{ overflow: 'hidden' }}>
                    <Typography fontWeight={700} noWrap title={binding.product}>{binding.product}</Typography>
                    <Typography variant="caption" color="text.secondary">Ozon SKU：{binding.sku}</Typography>
                    {row.products.length > 1 ? <Typography variant="caption">另有 {row.products.length - 1} 个商品</Typography> : null}
                  </TableCell>
                  <TableCell sx={{ overflow: 'hidden' }}>
                    <Typography noWrap title={binding.source}>{binding.source}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {binding.sourcePrice ? `SKU价 ${formatMoney(binding.sourcePrice)}` : 'SKU可为空，不影响其他采购信息同步'}
                    </Typography>
                  </TableCell>
                  <TableCell>{formatMoney(row.purchase.amount)}</TableCell>
                  <TableCell>
                    <Typography noWrap title={row.purchase.orderNumber || ''}>{row.purchase.orderNumber || '—'}</Typography>
                  </TableCell>
                  <TableCell title={row.rawStatus || ''}>
                    <Typography
                      component="span"
                      variant="body2"
                      fontWeight={700}
                      sx={{ color: getOzonOrderStatusTextColor(row.rawStatus) }}
                    >
                      {formatOzonOrderStatus(row.rawStatus)}
                    </Typography>
                  </TableCell>
                  <TableCell align="center">
                    <Stack alignItems="center" spacing={0.35}>
                      <Chip
                        size="small"
                        color={state.color}
                        icon={state.icon}
                        label={state.label}
                        clickable={section === automaticOrderSections.autoOrder && !row.allBound}
                        onClick={section === automaticOrderSections.autoOrder && !row.allBound
                          ? () => setBindingTarget(automaticOrderBindingTarget(row))
                          : undefined}
                        aria-label={section === automaticOrderSections.autoOrder && !row.allBound
                          ? `绑定货源 ${row.posting}`
                          : undefined}
                        sx={{ borderRadius: '6px' }}
                      />
                      {task?.message ? (
                        <Typography variant="caption" color={task.status === 'failed' ? 'error.main' : 'text.secondary'}>
                          {task.message}
                        </Typography>
                      ) : null}
                      {task?.status === 'paused' && task?.resumeTabId ? (
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => workflow.resumeRow(section, row.id)}
                          sx={{ minWidth: 64, py: 0.15 }}
                        >
                          继续付款
                        </Button>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {!workflow.loading && !workflow.rows.length ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 8 }}>暂无可显示订单</TableCell></TableRow>
            ) : null}
            {workflow.loading ? (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 8 }}>正在读取订单…</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog
        open={Boolean(bindingTarget)}
        onClose={() => setBindingTarget(null)}
        fullWidth
        maxWidth="xl"
        slotProps={{ paper: { sx: { height: 'calc(100vh - 24px)', maxHeight: 'calc(100vh - 24px)', borderRadius: '6px', overflow: 'hidden' } } }}
      >
        <DialogTitle component="div">
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
            <Box>
              <Typography variant="h5" component="div" fontWeight={800}>绑定当前订单货源</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {bindingTarget?.posting || ''} · {bindingTarget?.productName || ''}
              </Typography>
            </Box>
            <IconButton aria-label="关闭货源绑定弹窗" onClick={() => setBindingTarget(null)}>
              <CloseRounded />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 2, overflow: 'hidden', minHeight: 0 }}>
          {bindingTarget ? (
            <PurchaseSkuBindingPanel
              isActive
              initialOzonUrl={bindingTarget.ozonUrl}
              initialSourceUrl={bindingTarget.sourceUrl}
              scope={bindingTarget.scope}
              onSaved={(result) => {
                globalThis.dispatchEvent?.(new CustomEvent('wangzai:auto-order-binding-saved', {
                  detail: {
                    shopId: result?.binding?.shopId || bindingTarget.scope.shopId,
                    ozonSkuIds: (result?.binding?.pairs || []).map((pair) => pair.ozonSkuId).filter(Boolean),
                  },
                }));
                setBindingTarget(null);
                void workflow.refresh();
              }}
              showSavedBindings={false}
              fitViewport
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

export function AutomaticOrderRunLog({ workflow }) {
  if (!workflow.logs.length) return null;
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: '6px' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography fontWeight={800}>运行记录</Typography>
        <Button size="small" onClick={workflow.clearLogs}>清空记录</Button>
      </Stack>
      <Stack spacing={0.6}>
        {workflow.logs.slice(0, 20).map((log) => (
          <Box key={log.id} sx={{ display: 'grid', gridTemplateColumns: '150px 190px 1fr', gap: 1, alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary">{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</Typography>
            <Typography variant="body2" fontWeight={700}>{log.posting}</Typography>
            <Typography variant="body2" color={log.status === 'error' ? 'error.main' : 'success.main'}>{log.message}</Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
