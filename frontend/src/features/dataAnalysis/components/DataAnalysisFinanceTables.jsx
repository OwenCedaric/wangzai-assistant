import {
  formatDataAnalysisMetric,
  formatDataAnalysisMoney,
  formatDataAnalysisOperationType,
  formatMoneyBreakdown,
} from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

export function DataAnalysisFinanceOperationTable({ rows = [], flowSummary = {} }) {
  const totalCount = rows.reduce((sum, row) => sum + (Number(row?.count) || 0), 0);
  const positiveAmount = Number.isFinite(Number(flowSummary.positiveAmount))
    ? Number(flowSummary.positiveAmount)
    : rows.reduce((sum, row) => sum + Math.max(0, Number(row?.amount?.value) || 0), 0);
  const deductionAmount = Number.isFinite(Number(flowSummary.negativeAmount))
    ? Number(flowSummary.negativeAmount)
    : Math.abs(rows.reduce((sum, row) => sum + Math.min(0, Number(row?.amount?.value) || 0), 0));
  return (
    <DataAnalysisPanelShell
      title="费用结构"
      subtitle="结算币种为卢布，所有金额已按对应流水日期汇率折算为人民币。"
      sourceLabel="平台财务流水"
    >
      {rows.length ? (
        <Stack spacing={1.1} sx={{ flex: 1, minHeight: 0, justifyContent: 'space-between' }}>
          <TableContainer sx={{ maxHeight: 440, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
            <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: '50%', whiteSpace: 'nowrap' }}>操作类型</TableCell>
                  <TableCell align="right" sx={{ width: '18%', whiteSpace: 'nowrap' }}>笔数</TableCell>
                  <TableCell align="right" sx={{ width: '32%', whiteSpace: 'nowrap' }}>金额汇总</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.code} hover>
                    <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                      <Typography variant="body2" fontWeight={700} noWrap title={formatDataAnalysisOperationType(row.code)}>
                        {formatDataAnalysisOperationType(row.code)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{Number(row.count || 0).toLocaleString('zh-CN')}</TableCell>
                    <TableCell align="right" sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                      <Typography fontWeight={800} noWrap title={formatMoneyBreakdown(row.amount?.breakdown)}>
                        {formatMoneyBreakdown(row.amount?.breakdown)}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <DataAnalysisInsightGrid
            columns={3}
            items={[
              { label: '操作类型', value: `${rows.length} 类`, detail: `已汇总 ${totalCount.toLocaleString('zh-CN')} 笔` },
              { label: '正向流水', value: formatDataAnalysisMoney(positiveAmount, 'CNY'), tone: 'success' },
              { label: '扣减流水', value: formatDataAnalysisMoney(deductionAmount, 'CNY'), tone: 'danger' },
            ]}
          />
        </Stack>
      ) : (
        <DataAnalysisEmptyState sourceLabel="平台财务流水" />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisLargestDeductionsTable({ rows = [] }) {
  return (
    <DataAnalysisPanelShell
      title="主要扣减流水"
      subtitle="按人民币扣减金额排序。"
      sourceLabel="平台财务流水"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 440, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '17%', whiteSpace: 'nowrap' }}>日期</TableCell>
                <TableCell sx={{ width: '31%', whiteSpace: 'nowrap' }}>操作类型</TableCell>
                <TableCell sx={{ width: '25%', whiteSpace: 'nowrap' }}>订单</TableCell>
                <TableCell align="right" sx={{ width: '27%', whiteSpace: 'nowrap' }}>扣减金额</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.operationId} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{String(row.operationDate || '—').slice(0, 10)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <Typography variant="body2" noWrap title={formatDataAnalysisOperationType(row.operationType)}>
                      {formatDataAnalysisOperationType(row.operationType)}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <Typography variant="body2" noWrap title={row.postingNumber || '未关联'}>
                      {row.postingNumber || '未关联'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Typography fontWeight={900} color="success.main">
                      {row.currency === 'UNKNOWN'
                        ? '待确认'
                        : formatDataAnalysisMoney(row.amount, row.currency)}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <DataAnalysisEmptyState
          title="没有负向财务流水"
          description="所选期间没有金额小于零的财务记录。"
          sourceLabel="平台财务流水"
          statusLabel="真实结果"
        />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisFinanceReconciliationPanel({ metrics = [] }) {
  const metricById = new Map((Array.isArray(metrics) ? metrics : []).map((metric) => [metric.id, metric]));
  const items = [
    ['financeNetAmount', '平台流水净额'],
    ['financeIncomeAmount', '正向流水'],
    ['financeDeductionAmount', '扣减流水'],
    ['confirmedPurchaseCost', '已确认采购成本'],
    ['actualNetProfit', '实际净利润'],
    ['actualNetProfitCoverage', '实际利润覆盖率'],
  ].map(([id, fallback]) => {
    const metric = metricById.get(id);
    return { label: metric?.label || fallback, value: metric ? formatDataAnalysisMetric(metric) : '暂未返回' };
  });
  return (
    <DataAnalysisPanelShell
      title="财务核对摘要"
      subtitle="平台流水按发生日统计，采购成本按未取消订单统计，两者时间口径不同；这里只做并列核对，不直接相减为利润。"
      sourceLabel="平台财务流水与人工采购成本"
      dense
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
        {items.map((item) => (
          <Stack key={item.label} flex={1} minWidth={0} spacing={0.2} sx={{ borderRadius: 1.9, bgcolor: '#f6f8fc', px: 1.15, py: 0.9 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>{item.label}</Typography>
            <Typography variant="body2" fontWeight={900} noWrap title={item.value}>{item.value}</Typography>
          </Stack>
        ))}
      </Stack>
    </DataAnalysisPanelShell>
  );
}
