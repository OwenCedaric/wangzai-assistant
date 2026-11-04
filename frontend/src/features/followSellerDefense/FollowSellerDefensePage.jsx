import AddRounded from '@mui/icons-material/AddRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import GppGoodRounded from '@mui/icons-material/GppGoodRounded';
import LoginRounded from '@mui/icons-material/LoginRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFollowSellerDefense } from './model/useFollowSellerDefense.js';
import { formatFollowSellerError, formatFollowSellerErrorBrief } from './lib/followSellerDefenseDisplay.js';

const STATUS = Object.freeze({
  pending_capture: ['待巡查', 'default'],
  capture_failed: ['巡查失败', 'error'],
  clear: ['未发现跟卖', 'success'],
  detected: ['发现跟卖', 'warning'],
  preview_ready: ['待确认', 'info'],
  submission_ready: ['材料已就绪', 'info'],
  submitting: ['正在提交', 'info'],
  verification_ready: ['待复查结果', 'info'],
  submission_failed: ['投诉提交失败', 'error'],
  submission_rejected: ['投诉未通过', 'error'],
  detached: ['已剔除', 'success'],
  still_followed: ['仍被跟卖', 'warning'],
  prepare_failed: ['预览失败', 'error'],
  write_failed: ['写入失败', 'error'],
  verification_failed: ['复查失败', 'error'],
});

const PREPARABLE = new Set([
  'detected',
  'still_followed',
  'prepare_failed',
  'submission_ready',
  'submission_failed',
  'submission_rejected',
]);

const FOLLOWED_CASE_STATUSES = new Set([
  'detected',
  'preview_ready',
  'submission_ready',
  'submitting',
  'verification_ready',
  'submission_failed',
  'submission_rejected',
  'detached',
  'still_followed',
  'prepare_failed',
  'write_failed',
  'verification_failed',
]);

const FOLLOW_SELLER_ACTION_GAP = 1;

function text(value) {
  return String(value ?? '').trim();
}

function shopName(shop = {}) {
  return text(shop.shopAlias || shop.alias || shop.name || shop.label || shop.shopName || shop.id) || '未命名店铺';
}

function isFollowedCase(item = {}) {
  const followCountBefore = Number(item.followCountBefore);
  const followCountAfter = Number(item.followCountAfter);
  return (Number.isFinite(followCountBefore) && followCountBefore > 0)
    || (Number.isFinite(followCountAfter) && followCountAfter > 0)
    || FOLLOWED_CASE_STATUSES.has(item.status);
}

function matchesCaseSearch(item = {}, query = '') {
  const keywords = text(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!keywords.length) return true;
  const searchText = [
    `货号 ${text(item.offerId)}`,
    `sku ${text(item.sku)}`,
    `商品id ${text(item.productId)}`,
    `商品 ${text(item.productName)}`,
    ...(Array.isArray(item.groupOfferIds) ? item.groupOfferIds : []),
  ].join(' ').toLocaleLowerCase();
  return keywords.every((keyword) => searchText.includes(keyword));
}

function StatusLabel({ status }) {
  const [label, color] = STATUS[status] || ['状态待确认', 'default'];
  const tone = color === 'default' ? 'text.secondary' : `${color}.main`;
  return (
    <Box
      data-testid="follow-seller-status-label"
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, color: tone, whiteSpace: 'nowrap' }}
    >
      <Box component="span" sx={{ width: 4, height: 16, borderRadius: '1px', bgcolor: tone, flexShrink: 0 }} />
      <Typography component="span" variant="body2" color="inherit" fontWeight={800}>{label}</Typography>
    </Box>
  );
}

function Scheme1ProgressPanel({ entries = [], active = false, error = '', notice = '' }) {
  const scrollRef = useRef(null);
  const current = entries.at(-1) || null;
  const feedback = error
    ? { tone: 'error', message: error }
    : notice
      ? { tone: 'success', message: notice }
      : current
        ? { tone: current.status === 'failed' ? 'error' : current.status === 'completed' ? 'success' : 'primary', message: current.message }
        : { tone: 'muted', message: '点击方案1后，这里会显示浏览器的真实操作步骤。' };
  const visibleEntries = entries.filter((entry) => !(
    entry.message === feedback.message
    && (entry.status === 'failed' || entry.status === 'completed')
  ));

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, current?.at]);

  return (
    <Paper
      data-testid="scheme1-live-progress"
      variant="outlined"
      sx={{ p: 1.4, borderRadius: '8px', bgcolor: '#f8faff' }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 0.8 }}>
        <Stack direction="row" alignItems="center" spacing={0.8}>
          {active ? <CircularProgress size={16} /> : <CheckCircleRounded color={entries.length ? 'success' : 'disabled'} sx={{ fontSize: 18 }} />}
          <Typography variant="body2" fontWeight={800}>方案1实时执行进度</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">{active ? '执行中' : entries.length ? '已结束' : '等待执行'}</Typography>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.35fr) minmax(360px, 0.65fr)' }, gap: 1.2 }}>
        <Box
          ref={scrollRef}
          sx={{ maxHeight: 128, minHeight: 96, overflowY: 'auto', pr: 0.5 }}
        >
          {visibleEntries.length ? visibleEntries.map((entry, index) => {
            const failed = entry.status === 'failed';
            const completed = entry.status === 'completed';
            const timeValue = Date.parse(entry.at);
            const timeLabel = Number.isFinite(timeValue)
              ? new Date(timeValue).toLocaleTimeString('zh-CN', { hour12: false })
              : '刚刚';
            return (
              <Box
                key={entry.id || `${entry.stage}-${index}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '72px 10px minmax(0, 1fr)',
                  gap: 0.8,
                  alignItems: 'start',
                  py: 0.35,
                }}
              >
                <Typography variant="caption" color="text.secondary">{timeLabel}</Typography>
                <Box sx={{ width: 7, height: 7, borderRadius: '50%', mt: 0.65, bgcolor: failed ? 'error.main' : completed ? 'success.main' : 'primary.main' }} />
                <Typography variant="caption" color={failed ? 'error.main' : 'text.primary'}>
                  {entry.offerId ? `货号 ${entry.offerId}：` : ''}{entry.message}
                </Typography>
              </Box>
            );
          }) : (
            <Typography variant="caption" color="text.secondary">当前没有正在执行的方案1任务。</Typography>
          )}
        </Box>
        <Box
          data-testid="scheme1-feedback"
          sx={{
            minHeight: 96,
            px: 1.5,
            py: 1.2,
            borderRadius: '6px',
            bgcolor: feedback.tone === 'error' ? '#fff6f3' : feedback.tone === 'success' ? '#f1fbf7' : feedback.tone === 'primary' ? '#f2f6ff' : '#f5f7fb',
            border: '1px solid',
            borderColor: feedback.tone === 'error' ? '#ffd8cc' : feedback.tone === 'success' ? '#ccefe2' : feedback.tone === 'primary' ? '#d8e3ff' : '#e5e9f2',
            display: 'flex',
            alignItems: 'flex-start',
          }}
        >
          <Typography
            variant="body2"
            color={feedback.tone === 'error' ? 'error.main' : feedback.tone === 'success' ? 'success.main' : feedback.tone === 'muted' ? 'text.secondary' : 'text.primary'}
            sx={{ lineHeight: 1.75, overflowWrap: 'anywhere' }}
          >
            {feedback.message}
          </Typography>
        </Box>
      </Box>
    </Paper>
  );
}

function Stat({ label, value, color = 'text.primary', testId = '' }) {
  return (
    <Paper data-testid={testId || undefined} variant="outlined" sx={{ px: 2, py: 1.4, minWidth: 130, flex: '1 1 130px', borderRadius: '8px' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h5" color={color} fontWeight={800}>{value ?? 0}</Typography>
    </Paper>
  );
}

function CaseTable({
  cases,
  selectedIds,
  onToggle,
  onPreview,
  onResume,
	onRecheck,
	onContinue,
  busy,
  allowCaptureFailed = false,
  selectionEnabled = true,
  pageResetKey = '',
  emptyLabel = '暂无巡查记录',
}) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(100);
  const boundedPage = Math.min(page, Math.max(0, Math.ceil(cases.length / rowsPerPage) - 1));
  const visibleCases = cases.slice(boundedPage * rowsPerPage, boundedPage * rowsPerPage + rowsPerPage);

  useEffect(() => {
    setPage(0);
  }, [pageResetKey]);

  return (
    <Paper variant="outlined" sx={{ borderRadius: '8px', overflow: 'hidden' }}>
      <TableContainer sx={{ maxHeight: 'calc(100vh - 440px)', overflowX: 'hidden' }}>
        <Table
          stickyHeader
          size="small"
          aria-label="跟卖巡查结果"
          sx={{
            tableLayout: 'fixed',
            width: '100%',
            minWidth: 0,
            '& .MuiTableCell-root': {
              boxSizing: 'border-box',
              px: 1.25,
              py: 1,
              verticalAlign: 'middle',
            },
            '& .MuiTableCell-paddingCheckbox': {
              px: 0.75,
            },
            '& .MuiTableCell-head': {
              fontWeight: 800,
              color: 'text.primary',
            },
          }}
        >
          <colgroup>
            {selectionEnabled ? <col style={{ width: '4%' }} /> : null}
            <col style={{ width: selectionEnabled ? '28%' : '30%' }} />
            <col style={{ width: selectionEnabled ? '19%' : '20%' }} />
            <col style={{ width: selectionEnabled ? '7%' : '8%' }} />
            <col style={{ width: selectionEnabled ? '12%' : '13%' }} />
            <col style={{ width: selectionEnabled ? '14%' : '13%' }} />
            <col style={{ width: selectionEnabled ? '16%' : '16%' }} />
          </colgroup>
          <TableHead>
            <TableRow>
              {selectionEnabled ? <TableCell padding="checkbox" /> : null}
              <TableCell>商品</TableCell>
              <TableCell>货号 / SKU</TableCell>
              <TableCell align="center">跟卖数</TableCell>
              <TableCell>处理状态</TableCell>
              <TableCell>错误原因</TableCell>
              <TableCell align="center">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleCases.length ? visibleCases.map((item) => {
            const selectable = PREPARABLE.has(item.status)
              || (allowCaptureFailed && item.status === 'capture_failed');
            const canContinue = (item.status === 'submission_failed'
			  || (item.status === 'submission_ready' && item.writeResult))
			  && item.writePayload?.workflow === 'ozon-seller-backend-content-complaint-v2';
            const canStandaloneRecheck = !['clear', 'detached', 'verification_ready', 'still_followed', 'verification_failed'].includes(item.status);
            const beforeCount = Number(item.followCountBefore);
            const afterCount = Number(item.followCountAfter);
            const hasAfterCount = item.followCountAfter !== null
              && item.followCountAfter !== undefined
              && Number.isFinite(afterCount)
              && afterCount >= 0;
            const visibleFollowCount = hasAfterCount ? afterCount : item.followCountBefore;
            const errorInput = {
              code: item.lastErrorCode,
              message: item.lastErrorMessage,
            };
            const fullErrorText = formatFollowSellerError(errorInput);
            const briefErrorText = formatFollowSellerErrorBrief(errorInput);
            return (
              <TableRow hover key={item.id} selected={selectionEnabled && selectedIds.has(item.id)}>
                {selectionEnabled ? (
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selectedIds.has(item.id)}
                      disabled={!selectable || busy}
                      onChange={() => onToggle(item.id)}
                      inputProps={{ 'aria-label': `选择 ${item.offerId}` }}
                    />
                  </TableCell>
                ) : null}
                <TableCell sx={{ overflow: 'hidden' }}>
                  <Typography variant="body2" fontWeight={700} noWrap>{item.productName || '未返回商品名'}</Typography>
                  <Typography variant="caption" color="text.secondary">商品 ID：{item.productId || '未返回'}</Typography>
                </TableCell>
                <TableCell sx={{ overflow: 'hidden' }}>
                  <Typography variant="body2" fontWeight={700} noWrap>{item.offerId}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap display="block">SKU：{item.sku}</Typography>
                </TableCell>
                <TableCell align="center">
                  <Typography fontWeight={800} color={(visibleFollowCount || 0) > 0 ? 'warning.main' : 'success.main'}>
                    {visibleFollowCount ?? '—'}
                  </Typography>
                  {hasAfterCount && Number.isFinite(beforeCount) ? (
                    <Typography variant="caption" color="text.secondary">投诉前 {beforeCount}</Typography>
                  ) : null}
                </TableCell>
                <TableCell><StatusLabel status={item.status} /></TableCell>
                <TableCell sx={{ overflow: 'hidden' }}>
                  <Typography
                    variant="caption"
                    color={(item.lastErrorMessage || item.lastErrorCode) ? 'error.main' : 'text.secondary'}
                    noWrap
                    display="block"
                    title={fullErrorText || undefined}
                  >
                    {briefErrorText || '—'}
                  </Typography>
                </TableCell>
                <TableCell align="center" sx={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>
				  <Stack
					direction="row"
					spacing={FOLLOW_SELLER_ACTION_GAP}
					useFlexGap
					flexWrap="wrap"
					justifyContent="center"
					sx={{ minWidth: 0, '& .MuiButton-root': { minWidth: 0, px: 1 } }}
				  >
					{item.status === 'preview_ready' ? (
					  <Button size="small" variant="contained" onClick={() => onPreview(item)} disabled={busy}>查看并确认</Button>
					) : null}
					{['verification_ready', 'still_followed', 'verification_failed'].includes(item.status) ? (
					  <Button size="small" variant="outlined" onClick={() => onResume(item.id)} disabled={busy}>复查剔除结果</Button>
					) : null}
					{canStandaloneRecheck ? (
					  <Button size="small" variant="outlined" onClick={() => onRecheck(item.id)} disabled={busy}>单独复查</Button>
					) : null}
					{canContinue ? (
					  <Button size="small" variant="contained" onClick={() => onContinue(item.id)} disabled={busy}>继续剔除</Button>
					) : null}
				  </Stack>
                </TableCell>
              </TableRow>
            );
            }) : (
              <TableRow><TableCell colSpan={selectionEnabled ? 7 : 6} align="center" sx={{ py: 7, color: 'text.secondary' }}>{emptyLabel}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {cases.length > 100 ? (
        <TablePagination
          component="div"
          count={cases.length}
          page={boundedPage}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={[50, 100, 250]}
          labelRowsPerPage="每页"
          labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
        />
      ) : null}
    </Paper>
  );
}

export function FollowSellerDefensePage({
  shops = [],
  activeShopId = '',
  isActive = true,
  onActiveShopChange,
}) {
  const [tab, setTab] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [savedSearch, setSavedSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [previewCase, setPreviewCase] = useState(null);
  const flow = useFollowSellerDefense({ shops, activeShopId, isActive });
  const busy = Boolean(flow.busyAction);
  const savedFollowedCases = useMemo(
    () => (flow.overview.cases || []).filter(isFollowedCase),
    [flow.overview.cases],
  );
  const filteredSavedFollowedCases = useMemo(
    () => savedFollowedCases.filter((item) => matchesCaseSearch(item, savedSearch)),
    [savedFollowedCases, savedSearch],
  );
  const displayedCases = useMemo(() => {
    if (tab === 2) return filteredSavedFollowedCases;
    if (tab === 3) return flow.overview.cases || [];
    return flow.currentCases;
  }, [filteredSavedFollowedCases, flow.currentCases, flow.overview.cases, tab]);
  const selectableCaseIds = useMemo(() => {
    return displayedCases.filter((item) => (
      PREPARABLE.has(item.status) || (tab === 3 && item.status === 'capture_failed')
    )).map((item) => item.id);
  }, [displayedCases, tab]);
  const selectableCaseIdSet = useMemo(() => new Set(selectableCaseIds), [selectableCaseIds]);
  const selectedActionIds = useMemo(
    () => [...selectedIds].filter((id) => selectableCaseIdSet.has(id)),
    [selectableCaseIdSet, selectedIds],
  );
  const selectedFailedCaseIds = useMemo(() => (
    (flow.overview.cases || [])
      .filter((item) => item.status === 'capture_failed' && selectedIds.has(item.id))
      .map((item) => item.id)
  ), [flow.overview.cases, selectedIds]);

  useEffect(() => {
    setSelectedIds(new Set(flow.currentCases.filter((item) => PREPARABLE.has(item.status)).map((item) => item.id)));
  }, [flow.currentCases]);

  useEffect(() => {
    setSelectedIds(new Set());
    setPreviewCase(null);
    setSavedSearch('');
  }, [activeShopId]);

  useEffect(() => {
    setSelectedIds(new Set());
    setPreviewCase(null);
  }, [tab]);

  const complaintDraft = previewCase?.writePayload || {};
  const complaintRoute = Array.isArray(complaintDraft.route) ? complaintDraft.route : [];
  const followerSkus = Array.isArray(complaintDraft.followerSkus)
    ? complaintDraft.followerSkus
    : Array.isArray(previewCase?.groupOfferIds) ? previewCase.groupOfferIds : [];
  const complaintSellers = Array.isArray(complaintDraft.sellers) ? complaintDraft.sellers : [];
  const evidenceFiles = Array.isArray(complaintDraft.evidence?.files) ? complaintDraft.evidence.files : [];

  const toggleSelected = (id) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const selectAll = () => setSelectedIds((current) => {
    const next = new Set(current);
    selectableCaseIds.forEach((id) => next.add(id));
    return next;
  });
  const cancelSelectAll = () => setSelectedIds((current) => {
    const next = new Set(current);
    selectableCaseIds.forEach((id) => next.delete(id));
    return next;
  });

  const runManual = () => {
    if (!identifier.trim()) return;
    void flow.scanManual(identifier.trim()).catch(() => undefined);
  };

  const prepareSelected = () => {
    if (!selectedActionIds.length) return;
    void flow.prepare(selectedActionIds).catch(() => undefined);
  };

  const runScheme2Selected = () => {
    if (!selectedActionIds.length) return;
    void flow.runScheme2(selectedActionIds).catch(() => undefined);
  };

  const runScheme1Selected = () => {
    if (!selectedActionIds.length) return;
    void flow.runScheme1(selectedActionIds).catch(() => undefined);
  };

  const counts = flow.overview.counts || {};
  const scanPercent = flow.progress.total > 0 ? Math.round((flow.progress.done / flow.progress.total) * 100) : 0;

  return (
    <Box
      data-testid="follow-seller-defense-page"
      sx={{
        p: { xs: 1, md: 1.5 },
        height: '100%',
        overflow: 'auto',
        bgcolor: '#f5f7fb',
        '& .MuiButton-root': {
          borderRadius: '6px !important',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        },
        '& .MuiButtonGroup-root': { borderRadius: '6px !important' },
        '& .MuiButtonGroup-grouped': { borderRadius: '6px !important' },
        '& .MuiOutlinedInput-root': { borderRadius: '6px !important' },
        '& .MuiAlert-root': { borderRadius: '6px !important' },
      }}
    >
      <Stack spacing={1.5} sx={{ width: '100%', maxWidth: 'none', mx: 'auto' }}>
        <Paper sx={{ p: 2, borderRadius: '8px' }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            alignItems={{ xs: 'stretch', md: 'center' }}
            spacing={1.5}
            useFlexGap
            flexWrap="wrap"
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, flex: '1 1 430px' }}>
              <GppGoodRounded color="primary" sx={{ fontSize: 36 }} />
              <Box>
                <Typography variant="h5" fontWeight={900}>剔除跟卖</Typography>
                <Typography variant="body2" color="text.secondary">店铺只决定巡查哪些商品；巡查使用独立 Ozon 前台账号，不需要登录对应店铺后台。</Typography>
              </Box>
            </Box>
            <Stack direction="row" spacing={FOLLOW_SELLER_ACTION_GAP} alignItems="center" useFlexGap flexWrap="wrap" sx={{ minWidth: { xs: 0, md: 430 }, flex: '1 1 520px' }}>
              <FormControl size="small" sx={{ minWidth: 220, flex: 1 }}>
                <InputLabel id="follow-seller-login-label">Ozon 前台巡查账号</InputLabel>
                <Select
                  labelId="follow-seller-login-label"
                  label="Ozon 前台巡查账号"
                  value={flow.selectedLoginProfileId || ''}
                  onChange={(event) => void flow.chooseLoginProfile(event.target.value).catch(() => undefined)}
                  disabled={busy || !flow.loginProfiles.length}
                >
                  {flow.loginProfiles.map((profile) => (
                    <MenuItem key={profile.id} value={profile.id}>
                      {profile.platformName} · {profile.connected ? '已保存' : '待登录'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddRounded />}
                disabled={busy}
                onClick={() => void flow.createLoginProfile().catch(() => undefined)}
                sx={{ whiteSpace: 'nowrap' }}
              >新增前台账号</Button>
              <Button
                size="small"
                variant={flow.loginReady ? 'outlined' : 'contained'}
                startIcon={<LoginRounded />}
                disabled={busy || !flow.selectedLoginProfileId}
                onClick={() => void flow.openLoginProfile().catch(() => undefined)}
                sx={{ whiteSpace: 'nowrap' }}
              >{flow.loginReady ? '重新登录' : '登录'}</Button>
            </Stack>
            <FormControl size="small" sx={{ minWidth: 260, flex: '1 1 260px', maxWidth: 360 }}>
              <InputLabel id="follow-seller-shop-label">Ozon 店铺</InputLabel>
              <Select
                labelId="follow-seller-shop-label"
                label="Ozon 店铺"
                value={activeShopId || ''}
                onChange={(event) => onActiveShopChange?.(event.target.value)}
                disabled={busy}
              >
                {shops.map((shop) => <MenuItem key={shop.id} value={shop.id}>{shopName(shop)}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
        </Paper>

        <Stack direction="row" spacing={1.2} useFlexGap flexWrap="wrap">
          <Stat label="历史巡查商品" value={counts.total || 0} />
          <Stat testId="followed-product-count" label="发现跟卖" value={savedFollowedCases.length} color="warning.main" />
          <Stat label="等待确认" value={counts.preview_ready || 0} color="info.main" />
          <Stat label="已成功剔除" value={counts.detached || 0} color="success.main" />
          <Stat
            label="需要重试"
            value={(counts.capture_failed || 0)
              + (counts.still_followed || 0)
              + (counts.submission_failed || 0)
              + (counts.submission_rejected || 0)
              + (counts.prepare_failed || 0)
              + (counts.write_failed || 0)
              + (counts.verification_failed || 0)}
            color="error.main"
          />
        </Stack>

        <Paper sx={{ borderRadius: '8px', overflow: 'hidden' }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            useFlexGap
            flexWrap="wrap"
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tabs
              data-testid="follow-seller-tabs"
              value={tab}
              onChange={(_, value) => setTab(value)}
              variant="scrollable"
              scrollButtons="auto"
              TabIndicatorProps={{
                'data-testid': 'follow-seller-native-tab-indicator',
                style: { display: 'none' },
              }}
              sx={{
                ml: 2,
                flex: '1 1 560px',
                minWidth: 0,
                '& .MuiTab-root': {
                  position: 'relative',
                  overflow: 'visible',
                },
                '& .MuiTab-root::after': {
                  content: '""',
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: 0,
                  height: 3,
                  borderRadius: '2px 2px 0 0',
                  backgroundColor: 'transparent',
                },
                '& .MuiTab-root.Mui-selected::after': {
                  backgroundColor: 'primary.main',
                },
              }}
            >
              <Tab label="单货号处理" />
              <Tab label="全店巡查" />
              <Tab label={`查看被跟卖（${savedFollowedCases.length}）`} />
              <Tab label="任务记录" />
            </Tabs>
            <Stack
              data-testid="follow-seller-top-actions"
              direction="row"
              spacing={FOLLOW_SELLER_ACTION_GAP}
              useFlexGap
              flexWrap="wrap"
              alignItems="center"
              justifyContent={{ xs: 'flex-start', lg: 'flex-end' }}
              sx={{ pr: 2, pb: { xs: 1, lg: 0 }, minWidth: 0, flex: '0 1 auto' }}
            >
              <Button
                size="small"
                variant="contained"
                disabled={busy || !selectedActionIds.length}
                onClick={runScheme1Selected}
                sx={{ minWidth: 170 }}
	              >方案1：完整流程投诉</Button>
              <Button
                size="small"
                variant="contained"
                color="warning"
                disabled={busy || !selectedActionIds.length}
                onClick={runScheme2Selected}
                sx={{ minWidth: 190 }}
              >方案2：全自动提交证据</Button>
			  <Button
				size="small"
				variant="outlined"
				startIcon={flow.operationBrowserOpening ? <CircularProgress size={16} /> : <VisibilityRounded />}
				disabled={!flow.operationBrowserAvailable || flow.operationBrowserOpening}
				onClick={() => void flow.toggleOperationBrowser().catch(() => undefined)}
			  >{flow.operationBrowserVisible ? '隐藏操作页面' : '可视化操作页面'}</Button>
            </Stack>
          </Stack>
          <Box sx={{ p: 2.2 }}>
            {!flow.loginReady ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                还没有可用的 Ozon 前台巡查账号。任意一个可登录 Ozon 前台的账号都能供全部店铺共享，点击顶部“新增前台账号”完成保存。
              </Alert>
            ) : null}

            {tab === 0 ? (
              <Stack spacing={2}>
                <Stack data-testid="follow-seller-manual-actions" direction={{ xs: 'column', md: 'row' }} spacing={FOLLOW_SELLER_ACTION_GAP} useFlexGap flexWrap="wrap" alignItems={{ xs: 'stretch', md: 'center' }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="货号 / Ozon SKU / 商品 ID"
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') runManual(); }}
                    disabled={busy}
                    placeholder="只输入一个标识，系统自动补齐商品和店铺资料"
                  />
                  <Button
                    variant="contained"
                    startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <SearchRounded />}
                    disabled={busy || !activeShopId || !flow.loginReady || !identifier.trim()}
                    onClick={runManual}
                    sx={{ minWidth: 150 }}
                  >检查跟卖</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectableCaseIds.length} onClick={selectAll}>全选</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectedActionIds.length} onClick={cancelSelectAll}>取消全选</Button>
                  <Button variant="outlined" disabled={busy || !selectedActionIds.length} onClick={prepareSelected} sx={{ minWidth: 160 }}>生成处理预览</Button>
                </Stack>
                <CaseTable
                  cases={flow.currentCases}
                  selectedIds={selectedIds}
                  onToggle={toggleSelected}
                  onPreview={setPreviewCase}
                  onResume={(id) => void flow.resume(id).catch(() => undefined)}
				  onRecheck={(id) => void flow.recheck(id).catch(() => undefined)}
				  onContinue={(id) => void flow.continueScheme1(id).catch(() => undefined)}
                  busy={busy}
                />
              </Stack>
            ) : null}

            {tab === 1 ? (
              <Stack spacing={2}>
                <Stack data-testid="follow-seller-patrol-actions" direction={{ xs: 'column', md: 'row' }} spacing={FOLLOW_SELLER_ACTION_GAP} useFlexGap flexWrap="wrap" alignItems={{ xs: 'stretch', md: 'center' }}>
                  <Button
                    variant="contained"
                    startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <GppGoodRounded />}
                    disabled={busy || !activeShopId || !flow.loginReady}
                    onClick={() => void flow.scanShop().catch(() => undefined)}
                  >一键巡查全店</Button>
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<RefreshRounded />}
                    disabled={busy || !activeShopId || !flow.loginReady || flow.retryCaptureCount < 1}
                    onClick={() => void flow.retryFailedCaptures().catch(() => undefined)}
                  >一键重试巡查失败（{flow.retryCaptureCount || 0}）</Button>
                  {['scanning', 'canceling'].includes(flow.busyAction) ? (
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<StopCircleRounded />}
                      disabled={flow.busyAction === 'canceling'}
                      onClick={flow.cancelScan}
                    >{flow.busyAction === 'canceling' ? '正在停止' : '停止巡查'}</Button>
                  ) : null}
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, flex: '1 1 420px' }}>稳定网络最高 6 路并行，每条结果返回即回填；自动巡查到全店最后一个商品，遇到 403 或滑块会弹出原页面供手动验证，独立隐藏浏览器完成后自动关闭。</Typography>
                </Stack>
                {busy && flow.progress.total === 0 ? (
                  <Alert severity="info">正在建立巡查任务并读取商品清单，不会一直卡在这里。</Alert>
                ) : null}
                {busy && flow.progress.total > 0 ? (
                  <Box>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="caption">巡查进度（每条结果返回即回填列表）</Typography>
                      <Typography variant="caption">{flow.progress.done}/{flow.progress.total}，失败 {flow.progress.failed || 0}</Typography>
                    </Stack>
                    <LinearProgress variant="determinate" value={scanPercent} sx={{ mt: 0.5, height: 8, borderRadius: '3px' }} />
                  </Box>
                ) : null}
                <CaseTable
                  cases={flow.currentCases}
                  selectedIds={selectedIds}
                  onToggle={toggleSelected}
                  onPreview={setPreviewCase}
                  onResume={(id) => void flow.resume(id).catch(() => undefined)}
				  onRecheck={(id) => void flow.recheck(id).catch(() => undefined)}
				  onContinue={(id) => void flow.continueScheme1(id).catch(() => undefined)}
                  busy={busy}
                  selectionEnabled={false}
                />
              </Stack>
            ) : null}

            {tab === 2 ? (
              <Stack spacing={1.5}>
                <Scheme1ProgressPanel
                  entries={flow.scheme1Progress || []}
                  active={String(flow.busyAction || '').startsWith('scheme1-')}
                  error={flow.error}
                  notice={flow.notice}
                />
                <Stack data-testid="follow-seller-saved-actions" direction="row" spacing={FOLLOW_SELLER_ACTION_GAP} useFlexGap flexWrap="wrap" alignItems="center">
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<RefreshRounded />}
                    disabled={busy || !activeShopId}
                    onClick={() => void flow.refresh().catch(() => undefined)}
                  >刷新历史结果</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectableCaseIds.length} onClick={selectAll}>全选</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectedActionIds.length} onClick={cancelSelectAll}>取消全选</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectedActionIds.length} onClick={prepareSelected}>为已选商品生成处理预览</Button>
                  <TextField
                    size="small"
                    label="搜索货号 / SKU / 商品 ID / 商品名"
                    value={savedSearch}
                    onChange={(event) => setSavedSearch(event.target.value)}
                    disabled={busy}
                    placeholder="输入后过滤列表"
                    sx={{ minWidth: 280, maxWidth: 380, flex: '1 1 280px' }}
                  />
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    startIcon={flow.busyAction === 'canceling' ? <CircularProgress size={16} color="inherit" /> : <StopCircleRounded />}
                    disabled={!flow.canStopTask || flow.busyAction === 'canceling'}
                    onClick={flow.cancelCurrentTask}
                  >{flow.busyAction === 'canceling' ? '正在停止' : '停止任务'}</Button>
                </Stack>
                <CaseTable
                  cases={filteredSavedFollowedCases}
                  selectedIds={selectedIds}
                  onToggle={toggleSelected}
                  onPreview={setPreviewCase}
                  onResume={(id) => void flow.resume(id).catch(() => undefined)}
				  onRecheck={(id) => void flow.recheck(id).catch(() => undefined)}
				  onContinue={(id) => void flow.continueScheme1(id).catch(() => undefined)}
                  busy={busy}
                  pageResetKey={`${activeShopId}-saved-followed-${savedSearch}-${filteredSavedFollowedCases.length}`}
                  emptyLabel={savedSearch.trim()
                    ? '当前记录没有匹配商品'
                    : '上次巡查没有发现被跟卖商品'}
                />
              </Stack>
            ) : null}

            {tab === 3 ? (
              <Stack spacing={1.5}>
                <Stack data-testid="follow-seller-task-actions" direction="row" spacing={FOLLOW_SELLER_ACTION_GAP} useFlexGap flexWrap="wrap" alignItems="center">
                  <Button size="small" variant="outlined" disabled={busy || !selectableCaseIds.length} onClick={selectAll}>全选</Button>
                  <Button size="small" variant="outlined" disabled={busy || !selectedActionIds.length} onClick={cancelSelectAll}>取消全选</Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<RefreshRounded />}
                    disabled={busy || !activeShopId || !flow.loginReady || !selectedFailedCaseIds.length}
                    onClick={() => void flow.retryFailedCaptures(selectedFailedCaseIds).catch(() => undefined)}
                  >重试所选巡查失败（{selectedFailedCaseIds.length}）</Button>
                </Stack>
                <CaseTable
                  cases={flow.overview.cases || []}
                  selectedIds={selectedIds}
                  onToggle={toggleSelected}
                  onPreview={setPreviewCase}
                  onResume={(id) => void flow.resume(id).catch(() => undefined)}
				  onRecheck={(id) => void flow.recheck(id).catch(() => undefined)}
				  onContinue={(id) => void flow.continueScheme1(id).catch(() => undefined)}
                  busy={busy}
                  allowCaptureFailed
                />
              </Stack>
            ) : null}
          </Box>
        </Paper>
      </Stack>

      <Dialog open={Boolean(previewCase)} onClose={busy ? undefined : () => setPreviewCase(null)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberRounded color="warning" />确认剔除跟卖
        </DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning" sx={{ mb: 2 }}>
            当前不修改商品属性。系统已从本机权属记录生成并复核 PSD + PDF，提交时会自动上传、保存前后截图并读取 Ozon 回执。
          </Alert>
          <Stack spacing={1.5}>
            <Box>
              <Typography variant="caption" color="text.secondary">客服入口</Typography>
              <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" sx={{ mt: 0.8 }}>
                {complaintRoute.map((step, index) => (
                  <Box key={`${step}-${index}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.7 }}>
                    <Chip label={step} size="small" color="primary" variant="outlined" />
                    {index < complaintRoute.length - 1 ? <Typography color="text.secondary">→</Typography> : null}
                  </Box>
                ))}
              </Stack>
            </Box>
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">原商品 SKU</Typography>
              <Typography fontWeight={800} color="primary.main" sx={{ wordBreak: 'break-all' }}>
                {complaintDraft.originalSku || previewCase?.sku || '未返回'}
              </Typography>
            </Box>
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">跟卖商品 SKU（{followerSkus.length}）</Typography>
              <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                {followerSkus.map((sku) => <Chip key={sku} label={sku} size="small" color="warning" variant="outlined" />)}
              </Stack>
            </Box>
            {complaintSellers.length ? (
              <Box>
                <Typography variant="caption" color="text.secondary">跟卖卖家</Typography>
                <Stack spacing={0.8} sx={{ mt: 0.8 }}>
                  {complaintSellers.map((seller) => (
                    <Paper key={seller.sku} variant="outlined" sx={{ px: 1.4, py: 1, borderRadius: '6px' }}>
                      <Typography fontWeight={700}>{seller.sellerName || '未返回卖家名'} · ID {seller.sellerId || '未返回'}</Typography>
                      <Typography variant="caption" color="text.secondary">跟卖 SKU：{seller.sku}</Typography>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            ) : null}
            <Alert severity={evidenceFiles.length ? 'success' : 'error'}>
              {evidenceFiles.length
                ? `已准备 ${evidenceFiles.length} 个原创证据文件。`
                : complaintDraft.blockedReason || '缺少原创证据文件，已阻止提交。'}
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions
          data-testid="follow-seller-dialog-actions"
          sx={{
            px: 3,
            py: 2,
            gap: FOLLOW_SELLER_ACTION_GAP,
            flexWrap: 'wrap',
            '& .MuiButton-root': { flexShrink: 0, whiteSpace: 'nowrap' },
            '& .MuiButton-root + .MuiButton-root': { ml: '0 !important' },
          }}
        >
          <Button onClick={() => setPreviewCase(null)} disabled={busy}>取消</Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <CheckCircleRounded />}
            disabled={busy || !previewCase?.previewId || complaintDraft.submissionReady !== true || !evidenceFiles.length}
            onClick={() => {
              const target = previewCase;
              setPreviewCase(null);
              void flow.confirm({
                caseId: target.id,
                previewId: target.previewId,
              }).catch(() => undefined);
            }}
          >{evidenceFiles.length ? '确认提交投诉' : '缺少原创证据，暂不提交'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default FollowSellerDefensePage;
