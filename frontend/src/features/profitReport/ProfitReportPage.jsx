import RefreshRounded from '@mui/icons-material/RefreshRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { getOzonReadableShops, getOzonShopLabel } from '../../entities/order/orderShopScope.jsx';
import { getRubCnyRateForDate, readRubCnyExchangeRateContext } from '../../services/exchangeRateClient.js';
import {
  buildProfitReportBalanceRows,
  buildProfitReportTotals,
  countReturnedReportAmounts,
  convertProfitReportRows,
  formatProfitReportMoney,
  PROFIT_REPORT_AMOUNT_COLUMNS,
  PROFIT_REPORT_BALANCE_COLUMNS,
} from './lib/profitReportFields.js';
import { getProfitReportErrorMessage, readProfitReport, refreshProfitReport } from './services/profitReportService.js';

function dateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: dateKey(from), to: dateKey(to) };
}

function formatPeriod(row = {}) {
  const begin = String(row.periodBegin || '').slice(0, 10);
  const end = String(row.periodEnd || '').slice(0, 10);
  return begin && end ? `${begin} - ${end}` : begin || end || '未返回';
}

function formatCompactPeriod(row = {}) {
  const begin = String(row.periodBegin || '').slice(0, 10);
  const end = String(row.periodEnd || '').slice(0, 10);
  if (!begin && !end) return '未返回';
  if (begin && end && begin.slice(0, 4) === end.slice(0, 4)) {
    return `${begin.slice(5).replace('-', '/')}–${end.slice(5).replace('-', '/')}`;
  }
  return begin && end ? `${begin}–${end}` : begin || end;
}

function CompactMoney({ value, currencyCode = 'RUB', emphasized = false, missingLabel = '未返回' } = {}) {
  const number = value === null || value === undefined || value === '' ? null : Number(value);
  if (!Number.isFinite(number)) {
    return <Typography component="span" sx={{ color: 'warning.main', fontSize: 13, fontWeight: 700 }}>{missingLabel}</Typography>;
  }
  return (
    <Box component="span" sx={{ display: 'inline-grid', justifyItems: 'end', lineHeight: 1.05 }}>
      <Typography component="span" sx={{ fontSize: emphasized ? 14 : 13.5, fontWeight: emphasized ? 800 : 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)}
      </Typography>
      <Typography component="span" sx={{ color: 'text.secondary', fontSize: 10.5, fontWeight: 700, lineHeight: 1.2 }}>
        {currencyCode || 'RUB'}
      </Typography>
    </Box>
  );
}

const compactTableCellSx = {
  px: 0.8,
  py: 0.9,
  minWidth: 0,
  fontSize: 13,
  lineHeight: 1.2,
  verticalAlign: 'middle',
  overflow: 'hidden',
};

function downloadCsv(rows = []) {
  const headers = ['日期', '店铺', ...PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => column.label), '币种'];
  const lines = [headers, ...rows.map((row) => [
    formatPeriod(row), row.shopName || row.shopId,
    ...PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => row[column.key] ?? ''), row.currencyCode || 'RUB',
  ])].map((line) => line.map((value) => `"${String(value ?? '').replace(/"/gu, '""')}"`).join(','));
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ozon-profit-report-${dateKey(new Date())}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProfitReportPage({ shops = [], activeShopId = '', isActive = true } = {}) {
  const readableShops = React.useMemo(() => getOzonReadableShops(shops), [shops]);
  const initialRange = React.useMemo(defaultRange, []);
  const [view, setView] = React.useState('statement');
  const [shopScope, setShopScope] = React.useState('all');
  const [from, setFrom] = React.useState(initialRange.from);
  const [to, setTo] = React.useState(initialRange.to);
  const [report, setReport] = React.useState({ rows: [], balances: [], totalsByCurrency: {}, total: 0, updatedAt: '' });
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [currencyMode, setCurrencyMode] = React.useState('source');
  const [exchangeRateContext, setExchangeRateContext] = React.useState({
    todayKey: '', realtime: null, dailyRates: new Map(), errors: [],
  });
  const [exchangeRateLoading, setExchangeRateLoading] = React.useState(false);
  const selectedShops = React.useMemo(() => {
    if (shopScope === 'all') return readableShops;
    return readableShops.filter((shop) => String(shop.id) === String(shopScope));
  }, [readableShops, shopScope]);
  const selectedIds = React.useMemo(() => selectedShops.map((shop) => String(shop.id)), [selectedShops]);

  const load = React.useCallback(async () => {
    if (!selectedIds.length) {
      setReport({ rows: [], balances: [], totalsByCurrency: {}, total: 0, updatedAt: '' });
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload = await readProfitReport({ shopIds: selectedIds, from, to });
      if (payload?.ok === false) throw new Error(payload?.error?.message || '利润报表读取失败');
      setReport(payload || { rows: [], balances: [] });
    } catch (loadError) {
      setError(loadError?.message || '利润报表读取失败');
    } finally {
      setLoading(false);
    }
  }, [from, selectedIds, to]);

  React.useEffect(() => {
    if (!isActive) return;
    load();
  }, [isActive, load]);

  React.useEffect(() => {
    if (shopScope !== 'all' && !readableShops.some((shop) => String(shop.id) === String(shopScope))) {
      setShopScope(activeShopId && readableShops.some((shop) => String(shop.id) === String(activeShopId)) ? String(activeShopId) : 'all');
    }
  }, [activeShopId, readableShops, shopScope]);

  const handleRefresh = async () => {
    if (!selectedShops.length || refreshing) return;
    setRefreshing(true);
    setError('');
    try {
      const result = await refreshProfitReport({ shops: selectedShops, from, to });
      if (!result.ok && !result.pending) throw new Error(getProfitReportErrorMessage(result.results?.[0]?.error));
      await load();
    } catch (refreshError) {
      setError(getProfitReportErrorMessage(refreshError));
    } finally {
      setRefreshing(false);
    }
  };

  const rows = Array.isArray(report.rows) ? report.rows : [];
  const balanceRows = React.useMemo(() => buildProfitReportBalanceRows(report, selectedShops), [report, selectedShops]);
  const rateDateKeys = React.useMemo(() => [
    ...new Set([...rows, ...balanceRows].map((row) => String(row.periodEnd || to).slice(0, 10)).filter(Boolean)),
  ], [balanceRows, rows, to]);
  React.useEffect(() => {
    if (!isActive || currencyMode !== 'cny' || !rateDateKeys.length) return undefined;
    let alive = true;
    setExchangeRateLoading(true);
    readRubCnyExchangeRateContext(rateDateKeys, {
      includeRealtime: true,
      useBatchRates: true,
      maxLookbackDays: 10,
      timeoutMs: 8000,
      dailyConcurrency: 3,
    }).then((context) => {
      if (alive) setExchangeRateContext(context);
    }).catch((rateError) => {
      if (alive) setExchangeRateContext({ todayKey: '', realtime: null, dailyRates: new Map(), errors: [rateError] });
    }).finally(() => {
      if (alive) setExchangeRateLoading(false);
    });
    return () => { alive = false; };
  }, [currencyMode, isActive, rateDateKeys]);

  const getRateForReportRow = React.useCallback((row) => {
    const date = String(row?.periodEnd || to).slice(0, 10);
    return getRubCnyRateForDate(date, exchangeRateContext, { allowRealtimeFallback: false });
  }, [exchangeRateContext, to]);
  const displayRows = React.useMemo(() => convertProfitReportRows(rows, {
    mode: currencyMode,
    getRate: getRateForReportRow,
  }), [currencyMode, getRateForReportRow, rows]);
  const displayBalanceRows = React.useMemo(() => convertProfitReportRows(balanceRows, {
    mode: currencyMode,
    getRate: getRateForReportRow,
  }), [balanceRows, currencyMode, getRateForReportRow]);
  const sourceRowsById = React.useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const sourceBalanceRowsByShop = React.useMemo(() => new Map(balanceRows.map((row) => [row.shopId, row])), [balanceRows]);
  const totals = React.useMemo(() => buildProfitReportTotals(displayRows), [displayRows]);
  const summaryCards = [
    ['应计结算金额', totals.invoiceTransfer, 'invoiceTransferReturnedRows'],
    ['销售金额', totals.ordersAmount, 'ordersAmountReturnedRows'],
    ['退货金额', totals.returnsAmount, 'returnsAmountReturnedRows'],
    ['Ozon佣金', totals.commissionAmount, 'commissionAmountReturnedRows'],
  ];
  const summaryCurrency = totals.currencyCode || displayRows[0]?.currencyCode || (currencyMode === 'cny' ? 'CNY' : 'RUB');
  const exchangeRateReadyRows = displayRows.filter((row) => row.sourceCurrencyCode !== 'RUB' || row.exchangeRate).length;
  const exchangeRateMissingRows = displayRows.filter((row) => row.exchangeRateMissing).length;

  return (
    <Box className="profit-report-page" sx={{ width: '100%', minWidth: 0 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(300px, 1fr) minmax(790px, 900px)' }, alignItems: 'end', gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontSize: 27 }}>利润报表</Typography>
          <Typography color="text.secondary" mt={0.5} sx={{ fontSize: 14.5 }}>按 Ozon 官方财务报告展示店铺余额、结算金额与完整费用构成</Typography>
          <Typography variant="caption" color="text.secondary" display="block" mt={0.35} sx={{ fontSize: 12.5 }}>
            数据更新时间：{report.updatedAt ? new Date(report.updatedAt).toLocaleString('zh-CN') : '尚未同步'}
          </Typography>
        </Box>
        <Box className="profit-report-toolbar" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(150px, 1.2fr) repeat(2, minmax(132px, 1fr)) auto auto auto' }, gap: 1, alignItems: 'center', width: '100%', minWidth: 0 }}>
          <FormControl size="small" sx={{ minWidth: 0 }}>
            <Select value={shopScope} onChange={(event) => setShopScope(event.target.value)}>
              <MenuItem value="all">全部店铺</MenuItem>
              {readableShops.map((shop) => <MenuItem value={String(shop.id)} key={shop.id}>{getOzonShopLabel(shop)}</MenuItem>)}
            </Select>
          </FormControl>
          <TextField type="date" size="small" value={from} onChange={(event) => setFrom(event.target.value)} sx={{ minWidth: 0 }} />
          <TextField type="date" size="small" value={to} onChange={(event) => setTo(event.target.value)} sx={{ minWidth: 0 }} />
          <Button variant="contained" startIcon={<RefreshRounded />} onClick={handleRefresh} disabled={refreshing || !selectedShops.length} sx={{ height: 40, whiteSpace: 'nowrap', px: 1.5 }}>
            {refreshing ? '同步中' : '同步 Ozon'}
          </Button>
          <Button
            size="small"
            variant="contained"
            disableElevation
            aria-label={`当前显示${currencyMode === 'source' ? '原币' : '人民币'}，点击切换为${currencyMode === 'source' ? '人民币' : '原币'}`}
            title={`点击切换为${currencyMode === 'source' ? '人民币' : '原币'}`}
            onClick={() => setCurrencyMode((current) => (current === 'source' ? 'cny' : 'source'))}
            sx={{
              height: 40,
              minWidth: 76,
              px: 1.5,
              borderRadius: 1,
              fontSize: 12.5,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              boxShadow: 'none',
            }}
          >
            {currencyMode === 'source' ? '原币' : '人民币'}
          </Button>
          <Button variant="outlined" startIcon={<DownloadRounded />} onClick={() => downloadCsv(displayRows)} disabled={!displayRows.length} sx={{ height: 40, whiteSpace: 'nowrap', px: 1.5 }}>导出数据</Button>
        </Box>
      </Box>

      {error ? <Alert severity="warning" sx={{ mb: 1.5, py: 0.25 }}>{error}</Alert> : null}
      <Alert severity="info" sx={{ mb: 1.5, py: 0.35, '& .MuiAlert-message': { fontSize: 13.5 } }}>报表只读 Ozon 财务报告与余额接口；人民币按每个结算周期的 RUB/CNY 日汇率换算，汇率缺失时不会使用固定值。</Alert>

      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" spacing={1} mb={1.5}>
        <Tabs value={view} onChange={(_event, value) => setView(value)} sx={{ minHeight: 42, '& .MuiTab-root': { minHeight: 42, px: 2 } }}>
          <Tab value="balance" label="店铺余额" />
          <Tab value="statement" label="结算明细" />
        </Tabs>
        <Typography variant="caption" color={currencyMode === 'cny' && exchangeRateMissingRows ? 'warning.main' : 'text.secondary'} sx={{ fontSize: 12.5, fontWeight: 600 }}>
          {currencyMode === 'source'
            ? '当前显示 Ozon 原币金额'
            : exchangeRateLoading
              ? '正在读取 RUB/CNY 汇率…'
              : `人民币换算：${exchangeRateReadyRows}/${displayRows.length} 个结算周期可用${exchangeRateMissingRows ? `，${exchangeRateMissingRows} 个周期缺少汇率` : ''}`}
        </Typography>
      </Stack>

      {view === 'statement' ? (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5, mb: 1.5 }}>
            {summaryCards.map(([label, value, countKey]) => (
              <Card key={label} variant="outlined" sx={{ minWidth: 0 }}><CardContent sx={{ p: '16px !important' }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 14 }}>{label}</Typography>
                <Typography sx={{ mt: 0.35, fontSize: 19, fontWeight: 800, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums' }}>{formatProfitReportMoney(totals[countKey] ? value : null, summaryCurrency)}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.25} sx={{ fontSize: 12.5 }}>已返回 {totals[countKey] || 0}/{totals.rowCount || 0} 条</Typography>
              </CardContent></Card>
            ))}
          </Box>
          <TableContainer className="profit-report-table-wrap" sx={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', border: '1px solid', borderColor: 'divider', borderRadius: 2, backgroundColor: 'background.paper' }}>
            <Table size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8.5%' }} />
                <col style={{ width: '6.5%' }} />
                {PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => <col key={column.key} style={{ width: '6.5%' }} />)}
                <col style={{ width: '7%' }} />
              </colgroup>
              <TableHead><TableRow>
                <TableCell sx={compactTableCellSx}>日期</TableCell><TableCell sx={compactTableCellSx}>店铺</TableCell>
                {PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => <TableCell key={column.key} align="right" sx={{ ...compactTableCellSx, fontSize: 12.5, fontWeight: 800, overflowWrap: 'anywhere' }}>{column.label}</TableCell>)}
                <TableCell align="center" sx={{ ...compactTableCellSx, fontSize: 12.5, fontWeight: 800 }}>完整度</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {displayRows.map((row) => <TableRow key={row.id} hover>
                  <TableCell sx={{ ...compactTableCellSx, fontVariantNumeric: 'tabular-nums' }}>{formatCompactPeriod(row)}</TableCell><TableCell sx={{ ...compactTableCellSx, fontWeight: 600, overflowWrap: 'anywhere' }}>{row.shopName}</TableCell>
                  {PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => <TableCell key={column.key} align="right" sx={compactTableCellSx}><CompactMoney value={row[column.key]} currencyCode={row.currencyCode} missingLabel={row.exchangeRateMissing && sourceRowsById.get(row.id)?.[column.key] != null ? '汇率未返回' : '未返回'} /></TableCell>)}
                  <TableCell align="center" sx={compactTableCellSx}><Chip size="small" label={`${countReturnedReportAmounts(sourceRowsById.get(row.id) || row)}/${PROFIT_REPORT_AMOUNT_COLUMNS.length}`} color={countReturnedReportAmounts(sourceRowsById.get(row.id) || row) === PROFIT_REPORT_AMOUNT_COLUMNS.length ? 'success' : 'warning'} sx={{ height: 26, minWidth: 48, fontSize: 11.5, '& .MuiChip-label': { px: 0.8 } }} /></TableCell>
                </TableRow>)}
                {rows.length ? <TableRow sx={{ backgroundColor: '#f8faff', '& td': { borderBottom: 0 } }}>
                  <TableCell sx={{ ...compactTableCellSx, fontWeight: 800 }}>总计</TableCell><TableCell sx={{ ...compactTableCellSx, fontWeight: 800 }}>{rows.length} 条</TableCell>
                  {PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => <TableCell key={column.key} align="right" sx={compactTableCellSx}><CompactMoney value={totals[`${column.key}ReturnedRows`] ? totals[column.key] : null} currencyCode={summaryCurrency} emphasized /></TableCell>)}
                  <TableCell sx={compactTableCellSx} />
                </TableRow> : null}
              </TableBody>
            </Table>
          </TableContainer>
          {!displayRows.length && !loading ? <Alert severity="warning" sx={{ mt: 2 }}>当前范围没有已同步的结算报告，请点击“同步 Ozon”。</Alert> : null}
        </>
      ) : (
        <TableContainer sx={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', border: '1px solid', borderColor: 'divider', borderRadius: 2, backgroundColor: 'background.paper' }}>
          <Table size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead><TableRow><TableCell sx={compactTableCellSx}>店铺</TableCell><TableCell sx={compactTableCellSx}>最近结算周期</TableCell>{PROFIT_REPORT_BALANCE_COLUMNS.map((column) => <TableCell key={column.key} align="right" sx={{ ...compactTableCellSx, fontWeight: 700 }}>{column.label}</TableCell>)}<TableCell sx={compactTableCellSx}>更新时间</TableCell></TableRow></TableHead>
            <TableBody>{displayBalanceRows.map((row) => <TableRow key={row.shopId} hover>
              <TableCell sx={{ ...compactTableCellSx, fontWeight: 600 }}>{row.shopName}</TableCell><TableCell sx={compactTableCellSx}>{formatPeriod(row)}</TableCell>
              {PROFIT_REPORT_BALANCE_COLUMNS.map((column) => <TableCell key={column.key} align="right" sx={compactTableCellSx}><CompactMoney value={row[column.key]} currencyCode={row.currencyCode} missingLabel={row.exchangeRateMissing && sourceBalanceRowsByShop.get(row.shopId)?.[column.key] != null ? '汇率未返回' : '未返回'} /></TableCell>)}
              <TableCell sx={{ ...compactTableCellSx, fontVariantNumeric: 'tabular-nums' }}>{row.recordedAt ? new Date(row.recordedAt).toLocaleString('zh-CN') : '未同步'}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

export default ProfitReportPage;
