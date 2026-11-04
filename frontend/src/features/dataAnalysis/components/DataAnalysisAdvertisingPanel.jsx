import {
  formatDataAnalysisMoney,
  formatDataAnalysisTime,
  formatDataAnalysisUserMessage,
} from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisMetricGrid } from './DataAnalysisMetricGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

function getErrorMessage(error) {
  return formatDataAnalysisUserMessage(
    error?.message || error?.payload?.error?.message || error?.error?.message,
    '广告接口读取失败'
  );
}

function AdvertisingReadStatus({ data }) {
  const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
  const runningCount = campaigns.filter((item) => item.statusLabel === '运行中').length;
  const coverage = data?.statisticsCoverage || {};
  const statisticsLabel = data?.statisticsRead
    ? `${coverage.returnedCampaignCount || 0}/${coverage.campaignCount || campaigns.length} 个计划`
    : '暂未完整返回';
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
      <DataAnalysisPanelShell title="广告数据状态" subtitle="本次读取结果按计划信息与统计信息分别展示。" sourceLabel="平台广告接口" dense>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.8 }}>
          {[
            { label: '已读计划', value: `${campaigns.length} 个` },
            { label: '运行中', value: `${runningCount} 个` },
            { label: '统计指标', value: statisticsLabel },
          ].map((item) => (
            <Box key={item.label} sx={{ minWidth: 0, borderRadius: 2, bgcolor: '#f6f8fc', px: 1.05, py: 1 }}>
              <Typography color="text.secondary" variant="caption" fontWeight={700}>{item.label}</Typography>
              <Typography fontWeight={900} variant="body2" mt={0.2} noWrap>{item.value}</Typography>
            </Box>
          ))}
        </Box>
      </DataAnalysisPanelShell>
      <DataAnalysisPanelShell title="数据使用说明" subtitle="避免把未返回的统计项误判为零投放。" sourceLabel="平台广告接口" dense>
        <Typography color="text.secondary" variant="body2" sx={{ lineHeight: 1.65 }}>
          {data?.statisticsRead
            ? `本页已取得 ${coverage.returnedCampaignCount || 0}/${coverage.campaignCount || campaigns.length} 个计划的统计；未覆盖计划不会按0计算。`
            : '当前仅确认计划状态与策略；花费、曝光、点击、订单和广告成本销售比未返回时保持空值。'}
        </Typography>
      </DataAnalysisPanelShell>
    </Box>
  );
}

function AdvertisingAccessRequired({ description, statusLabel = '需要授权', title = '需要配置广告接口' }) {
  return (
    <Stack spacing={1.5}>
      <DataAnalysisPanelShell title={title} subtitle={description} sourceLabel="平台广告接口">
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.15 }}>
          {[
            ['广告计划', '计划状态、策略和投放位置'],
            ['投放效果', '曝光、点击、订单和成交额'],
            ['投放效率', '花费、广告成本销售比和单次点击成本'],
          ].map(([label, detail]) => (
            <Box key={label} sx={{ borderRadius: 2.25, bgcolor: '#f6f8fc', p: 1.5 }}>
              <Chip label={statusLabel} size="small" sx={{ bgcolor: '#eef1f6', color: 'text.secondary', fontWeight: 800 }} />
              <Typography fontWeight={900} variant="body2" mt={1.05}>{label}</Typography>
              <Typography color="text.secondary" variant="caption" sx={{ display: 'block', lineHeight: 1.55, mt: 0.35 }}>{detail}</Typography>
            </Box>
          ))}
        </Box>
      </DataAnalysisPanelShell>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
        <DataAnalysisPanelShell title="接入方式" subtitle="在设置中心保存平台广告接口的只读授权后，本页才会开始读取。" sourceLabel="平台广告接口" dense>
          <Typography color="text.secondary" variant="body2" sx={{ lineHeight: 1.65 }}>
            未完成授权前，页面不会用订单、销售额或历史缓存替代广告效果。
          </Typography>
        </DataAnalysisPanelShell>
        <DataAnalysisPanelShell title="展示原则" subtitle="数据一旦可用，将按来源和读取时间逐项展示。" sourceLabel="平台广告接口" dense>
          <Typography color="text.secondary" variant="body2" sx={{ lineHeight: 1.65 }}>
            未返回的统计项保持空值，不会显示为零投放，也不会生成示例数据。
          </Typography>
        </DataAnalysisPanelShell>
      </Box>
    </Stack>
  );
}

export function DataAnalysisAdvertisingPanel({ state }) {
  const loading = ['loading', 'refreshing'].includes(state.status);
  if (state.status === 'authorization_required') {
    return <AdvertisingAccessRequired description={getErrorMessage(state.error)} />;
  }
  if (state.status === 'error' && !state.data) {
    return (
      <Stack spacing={1.5}>
        <DataAnalysisPanelShell
          title="广告官方数据读取失败"
          subtitle={getErrorMessage(state.error)}
          sourceLabel="平台广告接口"
          action={<Button size="small" startIcon={<RefreshRounded />} onClick={() => state.refresh()}>重新读取</Button>}
        >
          <DataAnalysisEmptyState description="读取失败时不会保留或展示虚构广告数据。" sourceLabel="平台广告接口" statusLabel="读取失败" />
        </DataAnalysisPanelShell>
        <AdvertisingAccessRequired title="读取状态说明" description="检查授权后可重新读取；未成功返回前不会填充广告指标。" statusLabel="等待读取" />
      </Stack>
    );
  }
  if (loading && !state.data) {
    return (
      <DataAnalysisPanelShell
        title="正在读取官方广告统计"
        subtitle="完整统计会依次读取计划、日报、商品、花费和媒体统计。"
        sourceLabel="平台广告接口实时读取"
      >
        <Stack alignItems="center" spacing={1.5} py={6}>
          <CircularProgress size={34} />
          <Typography color="text.secondary">正在等待平台广告接口返回真实数据…</Typography>
        </Stack>
      </DataAnalysisPanelShell>
    );
  }
  const data = state.data;
  if (!data) return null;
  return (
    <Stack spacing={1.5}>
      <DataAnalysisPanelShell
        title="广告投放概况"
        subtitle={`更新于 ${formatDataAnalysisTime(data.finishedAt)}`}
        sourceLabel="平台广告接口"
        action={
          <Button size="small" startIcon={<RefreshRounded />} disabled={loading} onClick={() => state.refresh()}>
            重新读取
          </Button>
        }
      >
        {!data.statisticsRead ? (
          <Box sx={{ p: 1.25, borderRadius: 2.5, bgcolor: 'warning.lighter', color: 'warning.dark' }}>
            <Typography fontWeight={800} variant="body2">
              本次广告计划读取成功，但统计阶段没有成功返回，因此花费、曝光、点击和广告成本销售比保持空值。
            </Typography>
          </Box>
        ) : data.statisticsStatus === 'partial' ? (
          <Box sx={{ p: 1.25, borderRadius: 2.5, bgcolor: 'warning.lighter', color: 'warning.dark' }}>
            <Typography fontWeight={800} variant="body2">
              本次只有 {data.statisticsCoverage?.returnedCampaignCount || 0}/
              {data.statisticsCoverage?.campaignCount || data.campaigns.length} 个计划返回统计明细；零值仅代表已返回计划，未覆盖计划保持空值。
            </Typography>
          </Box>
        ) : null}
        <DataAnalysisMetricGrid metrics={data.metrics} minCardWidth={180} embedded />
      </DataAnalysisPanelShell>

      <DataAnalysisPanelShell title="广告计划" subtitle="计划状态、预算和投放效果" sourceLabel="平台广告接口">
        {data.campaigns.length ? (
          <TableContainer sx={{ maxHeight: 460, width: '100%', minWidth: 0, overflowX: 'hidden' }}>
            <Table stickyHeader size="small" sx={{ width: '100%', tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: '27%', whiteSpace: 'nowrap' }}>计划</TableCell>
                  <TableCell sx={{ width: '12%', whiteSpace: 'nowrap' }}>状态</TableCell>
                  <TableCell sx={{ width: '13%', whiteSpace: 'nowrap' }}>策略</TableCell>
                  <TableCell align="right" sx={{ width: '9%', whiteSpace: 'nowrap' }}>曝光</TableCell>
                  <TableCell align="right" sx={{ width: '8%', whiteSpace: 'nowrap' }}>点击</TableCell>
                  <TableCell align="right" sx={{ width: '13%', whiteSpace: 'normal', lineHeight: 1.2 }}>花费（人民币）</TableCell>
                  <TableCell align="right" sx={{ width: '7%', whiteSpace: 'nowrap' }}>订单</TableCell>
                  <TableCell align="right" sx={{ width: '11%', whiteSpace: 'normal', lineHeight: 1.2 }}>广告成本销售比</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.campaigns.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                      <Stack spacing={0.2} sx={{ minWidth: 0, overflow: 'hidden' }}>
                        <Typography fontWeight={800} variant="body2" noWrap title={row.title || row.id}>
                          {row.title || row.id}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {formatDataAnalysisUserMessage(row.typeLabel || row.type, '类型未返回')} ·{' '}
                          {formatDataAnalysisUserMessage(row.placement, '位置未返回')}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden' }}>
                      <Chip
                        size="small"
                        color={row.statusLabel === '运行中' ? 'success' : 'default'}
                        label={formatDataAnalysisUserMessage(row.statusLabel || row.status, '状态未返回')}
                        sx={{ maxWidth: '100%', '.MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                      />
                    </TableCell>
                    <TableCell sx={{ minWidth: 0, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatDataAnalysisUserMessage(row.strategy, '策略未返回')}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{row.impressions ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{row.clicks ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.spentCny == null ? '—' : formatDataAnalysisMoney(row.spentCny, 'CNY')}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{row.orders ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{row.acos == null ? '—' : `${Number(row.acos).toFixed(1)}%`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <DataAnalysisEmptyState sourceLabel="平台广告接口" description="官方接口没有返回广告计划。" />
        )}
      </DataAnalysisPanelShell>
      <AdvertisingReadStatus data={data} />
    </Stack>
  );
}
