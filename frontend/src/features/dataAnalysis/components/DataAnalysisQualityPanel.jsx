import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function QualityRow({ label, value, count, total }) {
  const progress = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
  return (
    <Stack spacing={0.55}>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
          <Typography variant="body2" fontWeight={750} sx={{ fontSize: 14.5 }}>
          {label}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13.5 }}>
          {count}/{total} · {progress.toFixed(1)}%
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={progress}
        color={progress >= 90 ? 'success' : progress >= 50 ? 'primary' : 'warning'}
        sx={{ height: 8, borderRadius: 99 }}
      />
    </Stack>
  );
}

export function DataAnalysisQualityPanel({ quality = {}, showFieldGaps = false }) {
  const total = Number(quality.total) || 0;
  const syncAttemptedCount = Math.max(0, Number(quality.syncAttemptedCount) || 0);
  const priceUsableCount = Math.max(0, Number(quality.priceUsableCount ?? quality.priceKnownCount) || 0);
  const stockQuantityCount = Math.max(0, Number(quality.stockKnownCount) || 0);
  const stockResultKnownCount = Math.max(
    stockQuantityCount,
    Number(quality.stockResultKnownCount ?? quality.stockKnownCount) || 0
  );
  const categoryKnownCount = Math.max(0, Number(quality.categoryKnownCount) || 0);
  const completeCount = Math.max(0, Number(quality.completeCount) || 0);
  const knownFieldCount = [
    priceUsableCount,
    stockQuantityCount,
    categoryKnownCount,
  ].reduce((sum, value) => sum + value, 0);
  const coveragePercent = total ? (knownFieldCount / (total * 3)) * 100 : 0;
  return (
    <DataAnalysisPanelShell
      title="商品数据完整度"
      subtitle={`${quality.scopeLabel || '当前商品范围'}；区分“数量字段返回”和“明确无库存”，缺失值不补零。`}
      sourceLabel="平台商品补充数据"
    >
      <Stack spacing={1.35} sx={{ flex: 1, minHeight: 0, justifyContent: 'space-between' }}>
        <Stack spacing={1.25} sx={{ flex: 1, justifyContent: 'space-evenly' }}>
          <QualityRow
            label="有效价格"
            value={quality.priceCoveragePercent}
            count={priceUsableCount}
            total={total}
          />
          <QualityRow
            label="库存数量已返回"
            value={quality.stockCoveragePercent}
            count={stockQuantityCount}
            total={total}
          />
          <QualityRow
            label="类目可解析"
            value={quality.categoryCoveragePercent}
            count={categoryKnownCount}
            total={total}
          />
        </Stack>
        <DataAnalysisInsightGrid
          columns={3}
          sx={{ mt: 'auto' }}
          items={[
            { label: '统计商品', value: total.toLocaleString('zh-CN'), detail: quality.scopeLabel || '' },
            { label: '三项结果可判定', value: completeCount.toLocaleString('zh-CN') },
            { label: '字段覆盖', value: `${coveragePercent.toFixed(1)}%` },
            ...(showFieldGaps
              ? [
                  { label: '库存结果可判定', value: stockResultKnownCount.toLocaleString('zh-CN'), detail: '含平台明确返回无库存' },
                  {
                    label: '价格主字段可用',
                    value: (Number(quality.directPriceUsableCount) || 0).toLocaleString('zh-CN'),
                    detail: `另 ${Number(quality.priceFallbackCount) || 0} 条由官方价格详情补回`,
                  },
                  {
                    label: '官方类目名称返回',
                    value: (Number(quality.categoryNameReturnedCount) || 0).toLocaleString('zh-CN'),
                    detail: '名称未返回时仅用类目编号索引解析',
                  },
                  { label: '有库存商品', value: (Number(quality.inStockCount) || 0).toLocaleString('zh-CN') },
                  { label: '已执行同步', value: syncAttemptedCount.toLocaleString('zh-CN') },
                ]
              : []),
          ]}
        />
      </Stack>
    </DataAnalysisPanelShell>
  );
}
