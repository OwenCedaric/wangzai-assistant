import { formatDataAnalysisChineseText, formatMoneyBreakdown } from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisProductLink } from './DataAnalysisProductLink.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

export function DataAnalysisProductRankingTable({ rows = [], title = '商品销售排行', subtitle, emptyDescription, onProductLinkError }) {
  return (
    <DataAnalysisPanelShell
      title={title}
      subtitle={subtitle || '按所选期间未取消订单的商品销量排序。'}
      sourceLabel="平台订单商品明细"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 460, width: '100%', overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '10%', whiteSpace: 'nowrap' }}>排名</TableCell>
                <TableCell sx={{ width: '46%', whiteSpace: 'nowrap' }}>商品</TableCell>
                <TableCell align="right" sx={{ width: '12%', whiteSpace: 'nowrap' }}>销量</TableCell>
                <TableCell align="right" sx={{ width: '12%', whiteSpace: 'nowrap' }}>订单</TableCell>
                <TableCell align="right" sx={{ width: '20%', whiteSpace: 'nowrap' }}>销售额</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key || `${row.offerId}-${row.sku}`} hover>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Avatar
                      sx={{
                        width: 30,
                        height: 30,
                        fontSize: 13,
                        fontWeight: 900,
                        bgcolor: row.rank <= 3 ? 'primary.main' : 'grey.200',
                        color: row.rank <= 3 ? 'primary.contrastText' : 'text.secondary',
                      }}
                    >
                      {row.rank}
                    </Avatar>
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <DataAnalysisProductLink source={row} onError={onProductLinkError}>
                        <Typography component="span" fontWeight={800} variant="body2" noWrap maxWidth={360}>
                          {row.name}
                        </Typography>
                      </DataAnalysisProductLink>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        货号 {row.offerId || '未返回'} · 商品编码 {row.sku || '未返回'}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Typography fontWeight={800}>
                      {row.quantity == null ? '未返回' : Number(row.quantity).toLocaleString('zh-CN')}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{Number(row.orderCount || 0).toLocaleString('zh-CN')}</TableCell>
                  <TableCell align="right">
                    <Typography fontWeight={800}>{formatMoneyBreakdown(row.sales?.breakdown)}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <DataAnalysisEmptyState
          sourceLabel="平台订单商品明细"
          description={emptyDescription || '所选期间没有可用于排行的未取消订单商品。'}
        />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisStockRiskTable({ rows = [], onProductLinkError }) {
  return (
    <DataAnalysisPanelShell
      title="缺货与低库存商品"
      subtitle="只包含可经营候选商品；排除归档、校验失败和库存结果未确认的商品。"
      sourceLabel="平台库存本地数据"
    >
      {rows.length ? (
        <TableContainer sx={{ maxHeight: 460, width: '100%', overflowX: 'hidden' }}>
          <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '54%', whiteSpace: 'nowrap' }}>商品</TableCell>
                <TableCell sx={{ width: '16%', whiteSpace: 'nowrap' }}>状态</TableCell>
                <TableCell align="right" sx={{ width: '12%', whiteSpace: 'nowrap' }}>库存</TableCell>
                <TableCell sx={{ width: '18%', whiteSpace: 'nowrap' }}>数据源</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.productId}-${row.offerId}`} hover>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Stack spacing={0.25}>
                      <DataAnalysisProductLink source={row} onError={onProductLinkError}>
                        <Typography component="span" fontWeight={800} variant="body2" noWrap maxWidth={390}>
                          {row.name}
                        </Typography>
                      </DataAnalysisProductLink>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        货号 {row.offerId || '未返回'} · 商品编码 {row.sku || '未返回'}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={row.stock === 0 ? 'error' : 'warning'}
                      label={row.stock === 0 ? '缺货' : '低库存'}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Typography fontWeight={900}>{row.stock}</Typography>
                  </TableCell>
                  <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                    <Chip
                      size="small"
                      sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
                      label={`平台库存 · ${formatDataAnalysisChineseText(row.visibility, '状态未返回')}`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <DataAnalysisEmptyState
          title="没有缺货或低库存商品"
          description="当前已返回库存的可经营商品中，没有库存0–5件的记录。"
          sourceLabel="平台库存本地数据"
          statusLabel="真实结果"
        />
      )}
    </DataAnalysisPanelShell>
  );
}
