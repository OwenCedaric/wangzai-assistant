import { formatDataAnalysisChineseText, formatDataAnalysisMetric } from '../lib/dataAnalysisFormatter.js';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';

const severityMeta = Object.freeze({
  high: { color: '#d83c3c', icon: ErrorOutlineRounded, background: '#fff1f1' },
  medium: { color: '#b86b00', icon: WarningAmberRounded, background: '#fff7e8' },
  low: { color: '#3478c9', icon: InfoOutlined, background: '#eef6ff' },
  info: { color: '#687892', icon: InfoOutlined, background: '#f2f5f9' },
});

export function DataAnalysisDiagnosticsPanel({ rows = [], onOpenModule }) {
  const visibleRows = rows.slice(0, 3);
  return (
    <DataAnalysisPanelShell title="经营提醒" subtitle="优先处理影响销售和履约的问题" ariaLabel="经营提醒" dense>
      {visibleRows.length ? (
        <Stack divider={<Divider flexItem />}>
          {visibleRows.map((row) => {
            const meta = severityMeta[row.severity] || severityMeta.info;
            const Icon = meta.icon;
            return (
              <Stack key={row.id} direction="row" spacing={1} alignItems="flex-start" py={0.78} minWidth={0}>
                <Box
                  sx={{
                    width: 27,
                    height: 27,
                    display: 'grid',
                    placeItems: 'center',
                    flex: '0 0 auto',
                    borderRadius: 1.75,
                    color: meta.color,
                    bgcolor: meta.background,
                  }}
                >
                  <Icon sx={{ fontSize: 17 }} />
                </Box>
                <Stack spacing={0.12} flex={1} minWidth={0}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
                    <Typography fontWeight={850} variant="body2" noWrap>
                      {formatDataAnalysisChineseText(row.title)}
                    </Typography>
                    {row.evidence ? (
                      <Typography variant="caption" color="text.secondary" fontWeight={800} noWrap>
                        {formatDataAnalysisMetric(row.evidence)}
                      </Typography>
                    ) : null}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {formatDataAnalysisChineseText(row.action || row.message)}
                  </Typography>
                  {row.moduleId ? (
                    <Button
                      size="small"
                      onClick={() => onOpenModule?.(row.moduleId)}
                      sx={{ alignSelf: 'flex-start', minWidth: 0, p: 0, mt: 0.05, fontSize: 12 }}
                    >
                      去处理
                    </Button>
                  ) : null}
                </Stack>
              </Stack>
            );
          })}
          {rows.length > visibleRows.length ? (
            <Typography variant="caption" color="text.secondary" pt={1}>
              还有 {rows.length - visibleRows.length} 条提醒，可进入对应模块继续查看。
            </Typography>
          ) : null}
        </Stack>
      ) : (
        <Stack direction="row" alignItems="center" spacing={1} py={2.5} justifyContent="center">
          <CheckCircleOutlineRounded color="success" />
          <Typography fontWeight={800}>当前没有需要优先处理的问题</Typography>
        </Stack>
      )}
    </DataAnalysisPanelShell>
  );
}
