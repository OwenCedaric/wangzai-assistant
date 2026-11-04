import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import InfoRounded from '@mui/icons-material/InfoRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';

function count(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN');
}

export function DataAnalysisShopCoveragePanel({ quality = {} } = {}) {
  const shops = Array.isArray(quality.shopRows) ? quality.shopRows : [];
  const coreSources = (Array.isArray(quality.sourceCoverage) ? quality.sourceCoverage : [])
    .filter((source) => ['orders', 'products', 'finance', 'analytics'].includes(source.id));
  const covered = coreSources.reduce((sum, source) => sum + Number(source.coveredShopCount || 0), 0);
  const expected = coreSources.reduce((sum, source) => sum + Number(source.expectedShopCount || 0), 0);
  const healthy = (quality.scopeStatus || quality.status) === 'confirmed';
  const coverage = quality.metricCoverage || {};
  return (
    <DataAnalysisPanelShell
      title="店铺数据覆盖"
      subtitle={`当前范围 ${Number(quality.expectedShopCount) || shops.length} 家店铺；核心来源覆盖 ${covered}/${expected || 0} 个店铺×来源组合。`}
      sourceLabel="本地数据库交叉校验"
      dense
      action={
        <Chip
          size="small"
          color={healthy ? 'success' : 'warning'}
          icon={healthy ? <CheckCircleRounded /> : <InfoRounded />}
          label={healthy ? '聚合校验通过' : '存在覆盖缺口'}
        />
      }
    >
      {shops.length ? (
        <Box>
          <TableContainer sx={{ width: '100%', overflowX: 'hidden' }}>
            <Table size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '25%' }}>店铺</TableCell>
                <TableCell align="right">本期订单</TableCell>
                <TableCell align="right">商品缓存</TableCell>
                <TableCell align="right">财务流水</TableCell>
                <TableCell align="right">流量日数据</TableCell>
                <TableCell align="center" sx={{ width: 78 }}>广告接口</TableCell>
                <TableCell align="center" sx={{ width: 92 }}>周期状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shops.map((shop) => {
                const noOrders = Number(shop.orderRows) === 0;
                return (
                  <TableRow key={shop.shopId} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={800} noWrap title={shop.shopName}>{shop.shopName}</Typography>
                      <Typography variant="caption" color="text.secondary">历史订单 {count(shop.historicalOrderRows)}</Typography>
                    </TableCell>
                    <TableCell align="right">{count(shop.orderRows)}</TableCell>
                    <TableCell align="right">{count(shop.productRows)}</TableCell>
                    <TableCell align="right">{count(shop.financeRows)}</TableCell>
                    <TableCell align="right">{count(shop.analyticsRows)}</TableCell>
                    <TableCell align="center">
                      <Box component="span" sx={{ color: shop.performanceReady ? 'success.main' : 'text.secondary', fontSize: 12, fontWeight: 800 }}>
                        {shop.performanceReady ? '已绑定' : '未绑定'}
                      </Box>
                    </TableCell>
                    <TableCell align="center">
                      <Box component="span" sx={{ color: noOrders ? 'warning.main' : 'success.main', fontSize: 12, fontWeight: 800 }}>
                        {noOrders ? '本期0单' : '已纳入'}
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            </Table>
          </TableContainer>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', pt: 1 }}>
            <Chip size="small" variant="outlined" label={`类目编号 ${coverage.categoryIdCoveragePercent ?? '—'}% · 名称 ${coverage.categoryNameCoveragePercent ?? '—'}%`} />
            <Chip size="small" variant="outlined" label={`财务币种：官方 ${Number(coverage.financeOfficialCurrencyRows) || 0} · 规则判定 ${Number(coverage.financeInferredCurrencyRows) || 0}`} />
            <Chip size="small" variant="outlined" label={`流量截止：${coverage.latestAnalyticsDate || '未返回'}${Number(coverage.analyticsLagDays) > 0 ? ` · 延迟${coverage.analyticsLagDays}天` : ''}`} />
          </Box>
        </Box>
      ) : (
        <Typography color="text.secondary" variant="body2">当前没有可核对的店铺范围。</Typography>
      )}
    </DataAnalysisPanelShell>
  );
}

export default DataAnalysisShopCoveragePanel;
