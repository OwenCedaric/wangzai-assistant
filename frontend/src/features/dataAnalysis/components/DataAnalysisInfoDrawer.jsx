import { dataAnalysisGuardRails, sourceStatusMeta } from '../constants/dataAnalysisCatalog.js';
import {
  formatDataAnalysisChineseText,
  formatDataAnalysisCount,
  formatDataAnalysisTime,
} from '../lib/dataAnalysisFormatter.js';
import ApiRounded from '@mui/icons-material/ApiRounded';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DataObjectRounded from '@mui/icons-material/DataObjectRounded';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import ScheduleRounded from '@mui/icons-material/ScheduleRounded';
import StorageRounded from '@mui/icons-material/StorageRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

const POLICY_RULES = Object.freeze({
  localFirst: '页面优先读取本地业务缓存，避免重复请求官方接口。',
  fakeDataAllowed: '缺少真实来源时保持空值，不使用模拟数据补齐。',
  missingValuePolicy: '缺失指标会标注数据状态和来源，不以 0 冒充结果。',
  currencyPolicy: '币种未确认或存在混合币种时分别展示，不强行合并。',
  privacyPolicy: '分析结果不包含订单原始响应及买家隐私信息。',
});

function getPolicyRules(dataPolicy) {
  const policy = dataPolicy && typeof dataPolicy === 'object' ? dataPolicy : {};
  const rules = [];

  if (policy.localFirst === true) rules.push(POLICY_RULES.localFirst);
  if (policy.fakeDataAllowed === false) rules.push(POLICY_RULES.fakeDataAllowed);
  if (policy.missingValuePolicy) rules.push(POLICY_RULES.missingValuePolicy);
  if (policy.currencyPolicy) rules.push(POLICY_RULES.currencyPolicy);
  if (policy.privacyPolicy) rules.push(POLICY_RULES.privacyPolicy);

  return rules.length ? rules : dataAnalysisGuardRails;
}

function DataSourceIcon({ type = '' }) {
  const isEndpoint = String(type).includes('live') || String(type).includes('endpoint');
  return isEndpoint ? <ApiRounded fontSize="small" /> : <StorageRounded fontSize="small" />;
}

function DataSourceRow({ source = {} }) {
  const status = sourceStatusMeta[source.status] || {
    label: source.status || '状态未返回',
    color: 'default',
  };
  const endpoints = Array.isArray(source.endpoints) ? source.endpoints.filter(Boolean) : [];

  return (
    <Box sx={{ px: 2.25, py: 1.75 }}>
      <Stack spacing={1.1}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
            <Box
              sx={{
                width: 32,
                height: 32,
                flex: '0 0 auto',
                borderRadius: 1.75,
                display: 'grid',
                placeItems: 'center',
                color: 'primary.main',
                bgcolor: 'rgba(93, 135, 255, 0.1)',
              }}
            >
              <DataSourceIcon type={source.type} />
            </Box>
            <Box minWidth={0}>
              <Typography variant="body2" fontWeight={800} noWrap>
                {formatDataAnalysisChineseText(source.label, '未命名数据源')}
              </Typography>
              {source.note ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 0.2, lineHeight: 1.45 }}
                >
                  {formatDataAnalysisChineseText(source.note)}
                </Typography>
              ) : null}
            </Box>
          </Stack>
          <Chip
            size="small"
            color={status.color}
            label={formatDataAnalysisChineseText(status.label)}
            sx={{ flex: '0 0 auto', height: 24, border: 0, fontWeight: 700 }}
          />
        </Stack>

        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <DataObjectRounded sx={{ fontSize: 15, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.secondary">
              {formatDataAnalysisCount(source.rowCount)} 条
            </Typography>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <ScheduleRounded sx={{ fontSize: 15, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.secondary">
              {formatDataAnalysisTime(source.syncedAt)}
            </Typography>
          </Stack>
        </Stack>

        {endpoints.length ? (
          <Box
            component="details"
            sx={{
              '&[open] summary': { mb: 0.75 },
              '& summary': { listStyle: 'none' },
              '& summary::-webkit-details-marker': { display: 'none' },
            }}
          >
            <Box
              component="summary"
              sx={{
                width: 'fit-content',
                cursor: 'pointer',
                color: 'primary.main',
                typography: 'caption',
                fontWeight: 700,
                userSelect: 'none',
              }}
            >
              查看 {endpoints.length} 个数据端点
            </Box>
            <Stack spacing={0.5}>
              {endpoints.map((endpoint, index) => (
                <Box
                  key={endpoint}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    px: 1,
                    py: 0.6,
                    borderRadius: 1.25,
                    bgcolor: 'action.hover',
                  }}
                >
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>
                    数据接口 {index + 1}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    技术路径已收起
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}

/**
 * 数据分析页的次级说明抽屉。父组件负责渲染“数据说明”按钮并控制开关。
 */
export function DataAnalysisInfoDrawer({ open, onClose, sources = [], dataPolicy = {} }) {
  const safeSources = Array.isArray(sources) ? sources : [];
  const policyRules = getPolicyRules(dataPolicy);

  return (
    <Drawer
      anchor="right"
      open={Boolean(open)}
      onClose={onClose}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-label': '数据说明',
          sx: {
            width: { xs: 'min(100vw, 460px)', sm: 460 },
            maxWidth: '100vw',
            bgcolor: 'background.paper',
          },
        },
      }}
    >
      <Box sx={{ height: '100%', overflowY: 'auto' }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={2}
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            px: 2.25,
            py: 1.75,
            bgcolor: 'background.paper',
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Stack direction="row" alignItems="center" spacing={1.1}>
            <InfoOutlined color="primary" />
            <Box>
              <Typography variant="h6" fontWeight={900} lineHeight={1.2}>
                数据说明
              </Typography>
              <Typography variant="caption" color="text.secondary">
                来源、同步状态与指标口径
              </Typography>
            </Box>
          </Stack>
          <IconButton aria-label="关闭数据说明" onClick={onClose} size="small">
            <CloseRounded />
          </IconButton>
        </Stack>

        <Box sx={{ px: 2.25, pt: 2.25, pb: 1.5 }}>
          <Typography variant="overline" color="text.secondary" fontWeight={800}>
            指标口径与规则
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.75, p: 1.5, borderRadius: 2.25, bgcolor: 'rgba(93, 135, 255, 0.08)' }}>
            {policyRules.map((rule) => (
              <Stack key={rule} direction="row" alignItems="flex-start" spacing={0.9}>
                <CheckCircleOutlineRounded sx={{ mt: '2px', flex: '0 0 auto', fontSize: 17, color: 'primary.main' }} />
                <Typography variant="body2" color="text.secondary" lineHeight={1.55}>
                  {formatDataAnalysisChineseText(rule)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Box>

        <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ px: 2.25, py: 1 }}>
          <Typography variant="overline" color="text.secondary" fontWeight={800}>
            数据来源
          </Typography>
          <Typography variant="caption" color="text.disabled">
            共 {safeSources.length} 项
          </Typography>
        </Stack>
        <Divider />

        {safeSources.length ? (
          <Stack divider={<Divider flexItem />}>
            {safeSources.map((source, index) => (
              <DataSourceRow key={source.id || `${source.label || 'source'}-${index}`} source={source} />
            ))}
          </Stack>
        ) : (
          <Box sx={{ px: 2.25, py: 5, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              暂无可展示的数据源信息
            </Typography>
          </Box>
        )}
      </Box>
    </Drawer>
  );
}
