import { formatMoneyBreakdown } from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import { DataAnalysisProductLink } from './DataAnalysisProductLink.jsx';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function DataAnalysisOverviewProductRanking({ rows = [], onOpenModule, onProductLinkError }) {
  const visibleRows = rows.slice(0, 5);
  return (
    <DataAnalysisPanelShell
      title="热销商品"
      subtitle="按所选期间未取消订单销量排序"
      sourceLabel="平台订单商品"
      dense
      action={
        <Button size="small" onClick={() => onOpenModule?.('sales')}>
          查看全部
        </Button>
      }
    >
      {visibleRows.length ? (
        <Stack divider={<Divider flexItem />}>
          {visibleRows.map((row, index) => (
            <Stack
              key={row.key || `${row.offerId}-${row.sku}`}
              className="data-analysis-overview-product-row"
              direction="row"
              alignItems="center"
              spacing={1.1}
              py={0.85}
            >
              <Typography
                component="span"
                sx={{
                  width: 24,
                  height: 24,
                  display: 'grid',
                  placeItems: 'center',
                  flex: '0 0 auto',
                  borderRadius: 1.5,
                  bgcolor: index < 3 ? 'rgba(93, 135, 255, 0.12)' : '#f1f4f8',
                  color: index < 3 ? 'primary.main' : 'text.secondary',
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {row.rank || index + 1}
              </Typography>
              <Stack
                className="data-analysis-overview-product-main"
                flex={1}
                minWidth={0}
                spacing={0.1}
                sx={{ overflow: 'hidden' }}
              >
                <DataAnalysisProductLink
                  source={row}
                  onError={onProductLinkError}
                  className="data-analysis-overview-product-title-link"
                >
                  <Typography
                    component="span"
                    className="data-analysis-overview-product-title"
                    variant="body2"
                    fontWeight={850}
                    sx={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {row.name || row.offerId || '商品名称未返回'}
                  </Typography>
                </DataAnalysisProductLink>
                <Typography
                  className="data-analysis-overview-product-meta"
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {row.offerId || row.sku || '货号未返回'}
                </Typography>
              </Stack>
              <Stack
                className="data-analysis-overview-product-stats"
                alignItems="flex-end"
                spacing={0.1}
                sx={{ width: 86, minWidth: 86, flex: '0 0 86px', overflow: 'hidden' }}
              >
                <Typography variant="body2" fontWeight={900}>
                  {Number(row.quantity || 0).toLocaleString('zh-CN')} 件
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatMoneyBreakdown(row.sales?.breakdown)}
                </Typography>
              </Stack>
            </Stack>
          ))}
        </Stack>
      ) : (
        <DataAnalysisEmptyState description="所选期间没有可用于排行的订单商品。" sourceLabel="平台订单商品" />
      )}
    </DataAnalysisPanelShell>
  );
}
