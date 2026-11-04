import {
  formatDataAnalysisChineseText,
  formatDataAnalysisUserMessage,
  formatMoneyBreakdown,
} from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
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

function MarketingEmptyDetail({ kind }) {
  const isActivity = kind === 'activity';
  return (
    <Stack spacing={1.15}>
      <DataAnalysisEmptyState
        title={isActivity ? '本次未返回促销活动' : '本次未返回活动商品'}
        description={isActivity ? '当前官方活动快照中没有符合条件的活动记录。' : '当前官方活动商品快照中没有可展示的商品记录。'}
        sourceLabel={isActivity ? '平台促销活动本地数据' : '平台活动商品本地数据'}
        statusLabel="真实结果"
      />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.75 }}>
        {[
          { label: '返回记录', value: '0 条' },
          { label: '数据处理', value: '不生成示例数据' },
          { label: '查看方式', value: '刷新后重新读取' },
        ].map((item) => (
          <Box key={item.label} sx={{ minWidth: 0, borderRadius: 1.9, bgcolor: '#f6f8fc', px: 1, py: 0.75 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>{item.label}</Typography>
            <Typography variant="body2" fontWeight={850} noWrap sx={{ mt: 0.12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</Typography>
          </Box>
        ))}
      </Box>
    </Stack>
  );
}

export function DataAnalysisActivityTable({ rows = [] }) {
  return (
    <DataAnalysisPanelShell
      title="促销活动"
      subtitle="活动有效状态按平台开始时间、结束时间与筛选截止日计算。"
      sourceLabel="平台促销活动本地数据"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 460, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '27%', whiteSpace: 'nowrap' }}>活动</TableCell>
                <TableCell sx={{ width: '14%', whiteSpace: 'nowrap' }}>状态</TableCell>
                <TableCell sx={{ width: '16%', whiteSpace: 'nowrap' }}>类型</TableCell>
                <TableCell align="right" sx={{ width: '10%', whiteSpace: 'nowrap' }}>已参与</TableCell>
                <TableCell align="right" sx={{ width: '10%', whiteSpace: 'nowrap' }}>可加入</TableCell>
                <TableCell sx={{ width: '23%', whiteSpace: 'nowrap' }}>活动周期</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.activityId} hover>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Stack spacing={0.2} sx={{ minWidth: 0, overflow: 'hidden' }}>
                      <Typography fontWeight={800} variant="body2" noWrap title={row.title}>
                        {row.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap title={`活动编号 ${row.activityId}`}>
                        活动编号 {row.activityId}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Chip
                      size="small"
                      color={row.active ? 'success' : 'default'}
                      label={row.active ? '截止日有效' : '截止日无效'}
                      sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                    />
                  </TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatDataAnalysisUserMessage(row.actionType || row.sourceType, '活动类型未返回')}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {row.joinedCount == null ? '未返回' : Number(row.joinedCount).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {row.availableCount == null ? '未返回' : Number(row.availableCount).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.startDate || '未返回'} – {row.endDate || '未返回'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <MarketingEmptyDetail kind="activity" />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisActivityProductTable({ rows = [], onProductLinkError }) {
  return (
    <DataAnalysisPanelShell
      title="活动商品"
      subtitle="活动价和原价按官方原始字段展示，不计算归因销售额。"
      sourceLabel="平台活动商品本地数据"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 460, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '28%', whiteSpace: 'nowrap' }}>商品</TableCell>
                <TableCell sx={{ width: '13%', whiteSpace: 'nowrap' }}>活动</TableCell>
                <TableCell sx={{ width: '13%', whiteSpace: 'nowrap' }}>行状态</TableCell>
                <TableCell align="right" sx={{ width: '11%', whiteSpace: 'nowrap' }}>原价</TableCell>
                <TableCell align="right" sx={{ width: '12%', whiteSpace: 'nowrap' }}>活动价</TableCell>
                <TableCell align="right" sx={{ width: '11%', whiteSpace: 'nowrap' }}>活动库存</TableCell>
                <TableCell align="right" sx={{ width: '12%', whiteSpace: 'nowrap' }}>当前库存</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.activityId}-${row.productId}`} hover>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Stack spacing={0.2}>
                      <DataAnalysisProductLink source={row} onError={onProductLinkError}>
                        <Typography component="span" fontWeight={800} variant="body2" noWrap>
                          {row.name}
                        </Typography>
                      </DataAnalysisProductLink>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        货号 {row.offerId || '未返回'} · 商品编码 {row.sku || '未返回'}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.activityId}</TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Chip
                      size="small"
                      label={formatDataAnalysisChineseText(row.rowStatus, '状态未返回')}
                      sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                    />
                  </TableCell>
                  <TableCell align="right">
                    {row.priceCurrencyStatus === 'currency_unconfirmed'
                      ? '汇率未确认'
                      : row.price == null
                      ? '未返回'
                      : formatMoneyBreakdown([{ currency: row.currency || 'UNKNOWN', value: row.price }])}
                  </TableCell>
                  <TableCell align="right">
                    {row.activityPriceCurrencyStatus === 'currency_unconfirmed'
                      ? '汇率未确认'
                      : row.activityPrice == null
                      ? '未返回'
                      : formatMoneyBreakdown([{ currency: row.currency || 'UNKNOWN', value: row.activityPrice }])}
                  </TableCell>
                  <TableCell align="right">{row.stock == null ? '未返回' : row.stock}</TableCell>
                  <TableCell align="right">
                    <Stack alignItems="flex-end" spacing={0.2}>
                      <Typography variant="body2" fontWeight={800}>
                        {row.currentStock == null ? '未返回' : row.currentStock}
                      </Typography>
                      {row.stockMismatch ? (
                        <Typography variant="caption" color="warning.main">与活动库存不同</Typography>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <MarketingEmptyDetail kind="product" />
      )}
    </DataAnalysisPanelShell>
  );
}
