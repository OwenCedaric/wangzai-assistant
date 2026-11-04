import { formatDataAnalysisChineseText, formatDataAnalysisMoney } from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import { DataAnalysisProductLink } from './DataAnalysisProductLink.jsx';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

export function DataAnalysisReturnReasonTable({ rows = [], quality = {} }) {
  const defectCount = rows.reduce((sum, row) => sum + (row.isDefect ? Number(row.count) || 0 : 0), 0);
  const returnedReasonCount = Number(quality.reasonCodeReturnedCount) || rows.filter((row) => row.reasonId !== 'not-returned').reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  return (
    <DataAnalysisPanelShell
      title="售后原因分布"
      subtitle="按平台原因编号归类，并优先显示已核对的中文原因。"
      sourceLabel="平台售后原因"
    >
      <Box sx={{ p: 1.2, borderRadius: 2.5, bgcolor: '#f6f8fc', color: 'text.secondary' }}>
        <Typography variant="body2" fontWeight={700}>
          {formatDataAnalysisChineseText(quality.reasonTextNote || '原因名称暂不可用，已保留官方原因编号用于核查。')}
        </Typography>
      </Box>
      {rows.length ? (
        <Stack spacing={1.1}>
          <TableContainer sx={{ maxHeight: 400, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
            <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: '24%', whiteSpace: 'normal', lineHeight: 1.2 }}>平台原因编号</TableCell>
                  <TableCell sx={{ width: '36%', whiteSpace: 'nowrap' }}>售后原因</TableCell>
                  <TableCell align="right" sx={{ width: '14%', whiteSpace: 'nowrap' }}>售后数</TableCell>
                  <TableCell sx={{ width: '26%', whiteSpace: 'nowrap' }}>质量问题</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.reasonId} hover>
                    <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.reasonId === 'not-returned' ? '官方未返回' : row.reasonId}
                    </TableCell>
                    <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.reasonLabel || row.sourceName || '原因名称未返回'}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{Number(row.count || 0).toLocaleString('zh-CN')}</TableCell>
                    <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                      <Chip
                        size="small"
                        color={row.isDefect ? 'error' : 'default'}
                        label={row.isDefect ? '平台标记质量异常' : '平台未标记质量异常'}
                        sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <DataAnalysisInsightGrid
            columns={3}
            items={[
              { label: '原因分类', value: `${rows.length} 类` },
              { label: '质量问题售后', value: defectCount.toLocaleString('zh-CN'), tone: defectCount ? 'danger' : 'default' },
              { label: '已返回官方编号', value: returnedReasonCount.toLocaleString('zh-CN') },
            ]}
          />
        </Stack>
      ) : (
        <DataAnalysisEmptyState sourceLabel="平台售后原因" />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisRecentReturnsTable({ rows = [], onProductLinkError }) {
  return (
    <DataAnalysisPanelShell
      title="近期售后明细"
      subtitle="按售后创建时间倒序；金额为售后商品金额，不代表最终退款金额。"
      sourceLabel="平台售后本地数据"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 460, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '24%', whiteSpace: 'nowrap' }}>售后单</TableCell>
                <TableCell sx={{ width: '31%', whiteSpace: 'nowrap' }}>商品</TableCell>
                <TableCell sx={{ width: '15%', whiteSpace: 'nowrap' }}>状态</TableCell>
                <TableCell align="right" sx={{ width: '15%', whiteSpace: 'nowrap' }}>商品金额</TableCell>
                <TableCell sx={{ width: '15%', whiteSpace: 'nowrap' }}>创建时间</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.returnId} hover>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Stack spacing={0.2} sx={{ minWidth: 0, overflow: 'hidden' }}>
                      <Typography fontWeight={800} variant="body2" noWrap title={row.returnId}>
                        {row.returnId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap title={row.postingNumber || '未关联订单'}>
                        {row.postingNumber || '未关联订单'}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <DataAnalysisProductLink source={row} onError={onProductLinkError}>
                      <Typography component="span" variant="body2" fontWeight={700} noWrap title={row.productName} sx={{ display: 'block', maxWidth: '100%' }}>
                        {row.productName}
                      </Typography>
                    </DataAnalysisProductLink>
                  </TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Chip
                      size="small"
                      label={formatDataAnalysisChineseText(row.statusLabel, '状态未返回')}
                      sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                    />
                  </TableCell>
                  <TableCell align="right" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.currencyStatus === 'currency_unconfirmed'
                      ? '汇率未确认'
                      : row.amount == null
                      ? '—'
                      : row.currency === 'UNKNOWN'
                        ? `${row.amount}（币种未确认）`
                        : formatDataAnalysisMoney(row.amount, row.currency)}
                  </TableCell>
                  <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {String(row.createdAt || '—')
                      .slice(0, 16)
                      .replace('T', ' ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <DataAnalysisEmptyState sourceLabel="平台售后本地数据" />
      )}
    </DataAnalysisPanelShell>
  );
}
