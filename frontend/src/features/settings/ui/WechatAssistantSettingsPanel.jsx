import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  listSmartToolModelOptions,
  loadSmartToolModelState,
} from '../../promptLibrary/services/smartToolModelService.js';
import { requestWechatAssistant } from '../services/wechatAssistantSettingsService.js';
import { STABLE_SELECT_MENU_PROPS } from './stableSelectMenuProps.js';
import WechatAssistantPermissionDialog from './WechatAssistantPermissionDialog.jsx';

const ASSISTANT_STYLES = [
  { value: 'brief', label: '简洁汇报' },
  { value: 'analyst', label: '经营分析师' },
  { value: 'secretary', label: '执行秘书' },
  { value: 'audit', label: '严格审计' },
  { value: 'friendly', label: '轻松旺崽' },
];

const ACTIVE_LOGIN_PHASES = new Set(['starting', 'qr-ready', 'scanned', 'verify-code']);
const BUILTIN_MODEL_OPTIONS = [
  { id: 'gpt-5.6-terra', label: '轻量模型（省积分）' },
  { id: 'gpt-5.6-sol', label: '高性能模型（能力更强）' },
];
const SMALL_RADIUS = '6px';

function normalizeToolAccessMode(value) {
  return value === 'direct-write' || value === 'confirm-write' ? 'direct-write' : 'read-only';
}

function PanelCard({ title, children, action, sx }) {
  return (
    <Box
      component="section"
      sx={{
        minWidth: 0,
        minHeight: 0,
        border: '1px solid #e8edf6',
        borderRadius: SMALL_RADIUS,
        bgcolor: '#fff',
        p: 1.25,
        boxShadow: '0 2px 12px rgba(38, 46, 67, 0.04)',
        ...sx,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} mb={1}>
        <Typography variant="subtitle1" fontWeight={850}>{title}</Typography>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

function phaseLabel(phase) {
  return ({ running: '运行中', starting: '启动中', stopped: '未启动', stopping: '停止中', error: '异常' })[phase] || '未检测';
}

function recoveryLabel(phase) {
  return ({
    ready: '连接正常',
    degraded: '网络抖动',
    scheduled: '准备切换',
    cooldown: '等待重连',
    recovering: '正在切换',
    'waiting-safe-point': '等待安全切换',
    'send-outcome-unknown': '回信待核对',
    error: '恢复失败',
  })[phase] || '待检测';
}

function modelChannelLabel(channel, modelSource) {
  if (channel?.code === 'MODEL_POINTS_PRICE_UNAVAILABLE' || String(channel?.error || '').includes('积分价格')) return '积分价格未启用';
  if (channel?.code === 'OPENCLAW_CORE_ROUTE_UNAVAILABLE' || String(channel?.error || '').includes('版本尚未同步')) return '模型服务待更新';
  if (channel?.phase === 'requesting') return '请求处理中';
  if (channel?.phase === 'repairing') return '正在刷新';
  if (channel?.phase === 'outcome-unknown') return '结果待核对';
  if (channel?.phase === 'error') return '请求失败';
  return modelSource === 'builtin-points' ? '同模型安全切换' : '单接口·不盲重试';
}

function chineseVisibleError(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/没有当前功能的有效积分价格|积分价格暂不可用|MODEL_(?:PRESET_)?RATE_UNAVAILABLE|PAID_CAPABILITY_RATE_UNAVAILABLE/iu.test(text)) {
    return '当前模型暂未启用积分价格，本次没有调用模型，也不会扣积分；请联系管理员启用后重试。';
  }
  if (/OPENCLAW_CORE_ROUTE_UNAVAILABLE|模型服务版本尚未同步/iu.test(text)) {
    return '模型服务版本尚未同步，本次没有调用模型，也不会扣积分；请联系管理员更新服务。';
  }
  if (/This operation was aborted|AbortError|\baborted\b/iu.test(text)) return '回复处理超时，本次没有自动重发，请稍后再试。';
  if (!/[\u3400-\u9fff]/u.test(text)) return '操作没有完成，请稍后重试；详细原因已记录在本机诊断文件中。';
  return text;
}

function chineseDiagnosticLine(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const time = text.match(/^(\d{1,2}:\d{2}:\d{2})/u)?.[1];
  const prefix = time ? `${time} ` : '';
  if (/没有当前功能的有效积分价格|积分价格暂不可用|MODEL_(?:PRESET_)?RATE_UNAVAILABLE|PAID_CAPABILITY_RATE_UNAVAILABLE/iu.test(text)) {
    return `${prefix}【模型通道】${chineseVisibleError(text)}`;
  }
  if (/This operation was aborted|AbortError|\baborted\b/iu.test(text)) {
    return `${prefix}【微信通道】${chineseVisibleError(text)}`;
  }
  if (/OPENCLAW_CORE_ROUTE_UNAVAILABLE|模型服务版本尚未同步/iu.test(text)) {
    return `${prefix}【模型通道】${chineseVisibleError(text)}`;
  }
  if (/\[(?:gateway|model-relay|action-relay|setup|config|billing|recovery|wechat-login|diagnostic)\]/iu.test(text)) return '';
  if (/[A-Za-z]{3,}/u.test(text)) return '';
  return text.replace('[界面]', '【界面】');
}

function savedModelOptionLabel(item, index) {
  const usage = String(item?.usageScene || '').trim();
  return `已保存接口 ${index + 1}${usage && !/[A-Za-z]{3,}/u.test(usage) ? ` · ${usage}` : ''}`;
}

function WechatAssistantSettingsPanel({ saveRequestId = 0 }) {
  const [assistantName, setAssistantName] = React.useState('旺崽微信助理');
  const [assistantStyle, setAssistantStyle] = React.useState('brief');
  const [modelSource, setModelSource] = React.useState('builtin-points');
  const [modelAccountId, setModelAccountId] = React.useState('');
  const [modelName, setModelName] = React.useState('gpt-5.6-terra');
  const [toolAccessMode, setToolAccessMode] = React.useState('read-only');
  const [allowedOperationActions, setAllowedOperationActions] = React.useState([]);
  const [permissionDialogOpen, setPermissionDialogOpen] = React.useState(false);
  const [savedModelOptions, setSavedModelOptions] = React.useState([]);
  const [runtimeStatus, setRuntimeStatus] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [verifyCode, setVerifyCode] = React.useState('');
  const previousSaveRequestId = React.useRef(saveRequestId);
  const hydrated = React.useRef(false);

  const applyStatus = React.useCallback((nextStatus) => {
    if (!nextStatus) return;
    setRuntimeStatus(nextStatus);
    if (!hydrated.current && nextStatus.settings) {
      hydrated.current = true;
      setAssistantName(nextStatus.settings.assistantName || '旺崽微信助理');
      setAssistantStyle(nextStatus.settings.assistantStyle || 'brief');
      setModelSource(nextStatus.settings.modelSource || 'builtin-points');
      setModelAccountId(nextStatus.settings.modelAccountId || '');
      setModelName(nextStatus.settings.modelName || 'gpt-5.6-terra');
      setToolAccessMode(normalizeToolAccessMode(nextStatus.settings.toolAccessMode));
      setAllowedOperationActions(Array.isArray(nextStatus.settings.allowedOperationActions) ? nextStatus.settings.allowedOperationActions : []);
    }
  }, []);

  const refreshStatus = React.useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) {
      setBusy('status');
      setError('');
    }
    const result = await requestWechatAssistant({ command: 'status' });
    if (result.ok) applyStatus(result);
    else if (!quiet) setError(result.error || '内置环境检测失败。');
    if (!quiet) setBusy('');
    return result;
  }, [applyStatus]);

  React.useEffect(() => { void refreshStatus({ quiet: true }); }, [refreshStatus]);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSmartToolModelState({ signal: controller.signal })
      .then((state) => {
        const options = listSmartToolModelOptions(state)
          .filter((item) => item.ready && item.accountId && item.accountId !== 'builtin-points' && item.id !== 'auto');
        setSavedModelOptions(options);
      })
      .catch(() => setSavedModelOptions([]));
    return () => controller.abort();
  }, []);

  React.useEffect(() => {
    const active = ACTIVE_LOGIN_PHASES.has(runtimeStatus?.login?.phase)
      || runtimeStatus?.gateway?.phase === 'starting'
      || runtimeStatus?.gateway?.phase === 'running';
    if (!active) return undefined;
    const timer = window.setInterval(() => { void refreshStatus({ quiet: true }); }, 1200);
    return () => window.clearInterval(timer);
  }, [refreshStatus, runtimeStatus?.gateway?.phase, runtimeStatus?.login?.phase]);

  const currentSettings = React.useCallback(() => ({
    assistantName,
    assistantStyle,
    modelSource,
    modelAccountId,
    modelName,
    toolAccessMode,
    allowedOperationActions,
  }), [allowedOperationActions, assistantName, assistantStyle, modelAccountId, modelName, modelSource, toolAccessMode]);

  const saveConfiguration = React.useCallback(async () => {
    const result = await requestWechatAssistant({ command: 'save-settings', settings: currentSettings() });
    if (result.status) applyStatus(result.status);
    if (!result.ok) throw new Error(result.error || '配置保存失败。');
    return result;
  }, [applyStatus, currentSettings]);

  React.useEffect(() => {
    if (saveRequestId === previousSaveRequestId.current) return;
    previousSaveRequestId.current = saveRequestId;
    setBusy('save');
    setError('');
    void saveConfiguration().catch((reason) => setError(reason.message)).finally(() => setBusy(''));
  }, [saveConfiguration, saveRequestId]);

  const run = React.useCallback(async (command, { saveFirst = false, code } = {}) => {
    setBusy(command);
    setError('');
    try {
      if (saveFirst) await saveConfiguration();
      const result = await requestWechatAssistant({ command, ...(code ? { code } : {}) });
      if (result.status) applyStatus(result.status);
      else if (result.ok && command === 'status') applyStatus(result);
      if (!result.ok) throw new Error(result.error || '操作失败。');
      return result;
    } catch (reason) {
      setError(reason.message || String(reason));
      return null;
    } finally {
      setBusy('');
    }
  }, [applyStatus, saveConfiguration]);

  const gatewayRunning = runtimeStatus?.gateway?.phase === 'running';
  const loginConnected = runtimeStatus?.accounts?.count > 0 || runtimeStatus?.login?.phase === 'connected';
  const runtimeAvailable = runtimeStatus?.runtimeAvailable === true;
  const selectedSavedModelId = savedModelOptions.find((item) => item.accountId === modelAccountId && item.model === modelName)?.id || '';
  const canCheckConfiguration = runtimeAvailable
    && Boolean(modelName.trim())
    && (modelSource === 'builtin-points' || Boolean(selectedSavedModelId));
  const pointsReady = modelSource !== 'builtin-points'
    || (runtimeStatus?.points?.phase === 'ready' && Number(runtimeStatus?.points?.availablePoints) > 0);
  const canActivate = canCheckConfiguration
    && pointsReady
    && (toolAccessMode !== 'direct-write' || allowedOperationActions.length > 0);
  const qrDataUrl = runtimeStatus?.login?.qrDataUrl;
  const activateLabel = gatewayRunning ? '保存并重启内置版' : '保存并启用内置版';
  const diagnosticLines = [
    ...(Array.isArray(runtimeStatus?.logs) ? runtimeStatus.logs : []),
    ...(error ? [`【界面】${chineseVisibleError(error)}`] : []),
  ].map(chineseDiagnosticLine).filter((line, index, values) => line && line !== values[index - 1]);

  return (
    <Box
      data-testid="wechat-assistant-settings-panel"
      sx={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        '& .MuiChip-root, & .MuiButton-root, & .MuiOutlinedInput-root': {
          borderRadius: `${SMALL_RADIUS} !important`,
        },
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="h6" fontWeight={900}>微信助理</Typography>
          <Chip size="small" color="primary" label="旺崽内置版" />
          <Chip size="small" variant="outlined" color={runtimeAvailable ? 'success' : 'default'} label={runtimeAvailable ? `小龙虾 ${runtimeStatus?.runtimeVersion || ''}` : '内置环境待检测'} />
          <Chip size="small" variant="outlined" color={gatewayRunning ? 'success' : 'default'} label={`服务${phaseLabel(runtimeStatus?.gateway?.phase)}`} />
          <Chip size="small" variant="outlined" color={loginConnected ? 'success' : 'default'} label={loginConnected ? '微信已绑定' : '微信未绑定'} />
          {modelSource === 'builtin-points' ? (
            <Chip
              size="small"
              variant="outlined"
              color={runtimeStatus?.points?.phase === 'ready' ? 'success' : runtimeStatus?.points?.phase === 'depleted' ? 'error' : 'default'}
              label={runtimeStatus?.points?.phase === 'ready'
                ? `可用积分 ${runtimeStatus.points.availablePoints}`
                : runtimeStatus?.points?.phase === 'depleted'
                  ? '积分已耗尽'
                  : runtimeStatus?.points?.phase === 'error'
                    ? '积分核验失败'
                    : '积分待核验'}
            />
          ) : null}
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" disabled={Boolean(busy)} onClick={() => refreshStatus()}>
            检测内置版
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={Boolean(busy) || !canActivate}
            onClick={() => run(gatewayRunning ? 'restart' : 'start', { saveFirst: true })}
          >
            {busy === 'start' || busy === 'restart' ? '正在启用…' : activateLabel}
          </Button>
        </Stack>
      </Stack>

      <Box sx={{ minHeight: 0, flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(280px, 0.65fr)', gap: 1 }}>
        <Stack spacing={1} minWidth={0} minHeight={0} sx={{ overflowY: 'auto', pr: 0.25 }}>
          <PanelCard
            title="内置小龙虾与模型来源"
            action={<Chip size="small" variant="outlined" color={runtimeAvailable ? 'success' : 'default'} label={runtimeAvailable ? '组件完整' : '等待检测'} />}
            sx={{ flexShrink: 0 }}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(180px, 0.8fr) minmax(190px, 0.8fr) minmax(260px, 1.4fr)' }, gap: 1 }}>
              <TextField select fullWidth size="small" label="运行版本" value="bundled" SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}>
                <MenuItem value="bundled">旺崽助手内置版</MenuItem>
              </TextField>
              <TextField select fullWidth size="small" label="模型来源" value={modelSource} onChange={(event) => {
                const source = event.target.value;
                setModelSource(source);
                if (source === 'builtin-points') {
                  setModelAccountId('');
                  if (!BUILTIN_MODEL_OPTIONS.some((item) => item.id === modelName)) setModelName('gpt-5.6-terra');
                } else if (savedModelOptions[0]) {
                  setModelAccountId(savedModelOptions[0].accountId);
                  setModelName(savedModelOptions[0].model);
                }
              }} SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}>
                <MenuItem value="builtin-points">旺崽内置模型 · 扣积分</MenuItem>
                <MenuItem value="saved-api">已有模型接口 · 不扣积分</MenuItem>
              </TextField>
              {modelSource === 'builtin-points' ? (
                <TextField select fullWidth size="small" label="内置模型" value={modelName} onChange={(event) => setModelName(event.target.value)} SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}>
                  {BUILTIN_MODEL_OPTIONS.map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
                </TextField>
              ) : (
                <TextField select fullWidth size="small" label="已保存的接口与模型" value={selectedSavedModelId} onChange={(event) => {
                  const selected = savedModelOptions.find((item) => item.id === event.target.value);
                  setModelAccountId(selected?.accountId || '');
                  setModelName(selected?.model || '');
                }} SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }} error={!savedModelOptions.length} helperText={!savedModelOptions.length ? '请先到“模型接口”完成接口检测' : ''}>
                  {!savedModelOptions.length ? <MenuItem value="">暂无可用模型接口</MenuItem> : null}
                  {savedModelOptions.map((item, index) => <MenuItem key={item.id} value={item.id}>{savedModelOptionLabel(item, index)}</MenuItem>)}
                </TextField>
              )}
            </Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mt={0.8}>
              <Typography variant="caption" color="text.secondary">
                {modelSource === 'builtin-points'
                  ? '按模型实际用量预留并结算积分，失败释放；结果不确定时进入核对，不重复扣费。'
                  : '读取“模型接口”中已验证的配置，接口密钥只在主进程临时使用，不进入页面或小龙虾。'}
              </Typography>
              <Button size="small" variant="outlined" sx={{ flexShrink: 0 }} disabled={Boolean(busy) || !canCheckConfiguration} onClick={() => run('test-model', { saveFirst: true })}>
                {busy === 'test-model' ? '检查中…' : '检查配置'}
              </Button>
            </Stack>
          </PanelCard>

          <PanelCard
            title="助理设置"
            action={<Chip size="small" variant="outlined" label={toolAccessMode === 'direct-write' ? '授权操作直接生效' : '只读旺崽数据'} color={toolAccessMode === 'direct-write' ? 'warning' : 'info'} />}
            sx={{ flexShrink: 0 }}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(240px, 1.15fr)' }, gap: 1 }}>
              <TextField fullWidth size="small" label="助理名称" value={assistantName} onChange={(event) => setAssistantName(event.target.value)} />
              <TextField select fullWidth size="small" label="默认回复风格" value={assistantStyle} onChange={(event) => setAssistantStyle(event.target.value)} SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}>
                {ASSISTANT_STYLES.map((style) => <MenuItem key={style.value} value={style.value}>{style.label}</MenuItem>)}
              </TextField>
              <TextField select fullWidth size="small" label="小龙虾操作权限" value={toolAccessMode} onChange={(event) => {
                const mode = event.target.value;
                setToolAccessMode(mode);
                if (mode === 'direct-write') setPermissionDialogOpen(true);
              }} SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}>
                <MenuItem value="read-only">只读旺崽数据（推荐）</MenuItem>
                <MenuItem value="direct-write">允许操作与修改（直接生效）</MenuItem>
              </TextField>
            </Box>
            {toolAccessMode === 'direct-write' ? (
              <Stack direction="row" justifyContent="flex-end" mt={0.55}>
                <Button size="small" variant="outlined" color="warning" sx={{ flexShrink: 0 }} onClick={() => setPermissionDialogOpen(true)}>
                  配置具体权限（{allowedOperationActions.length}）
                </Button>
              </Stack>
            ) : null}
          </PanelCard>

          <PanelCard
            title="运行状态"
            sx={{ flex: '1 0 190px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' }, gap: 0.75 }}>
              {[
                ['微信组件', runtimeStatus?.pluginVersion || '待检测'],
                ['本机端口', runtimeStatus?.gateway?.port || '—'],
                ['微信账号', loginConnected ? `${runtimeStatus?.accounts?.count || 1} 个` : '未绑定'],
                ['微信通道', recoveryLabel(runtimeStatus?.channelRecovery?.phase)],
                ['模型通道', modelChannelLabel(runtimeStatus?.modelChannel, modelSource)],
                ['旺崽工具', toolAccessMode === 'direct-write'
                  ? (runtimeStatus?.operationToolAvailable ? `已授权 ${allowedOperationActions.length} 项` : '待检测')
                  : (runtimeStatus?.readonlyToolAvailable ? '只读可用' : '待检测')],
              ].map(([label, value]) => (
                <Box key={label} sx={{ bgcolor: '#f6f8fc', borderRadius: SMALL_RADIUS, px: 1, py: 0.7, minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary">{label}</Typography>
                  <Typography variant="body2" fontWeight={800} noWrap>{value}</Typography>
                </Box>
              ))}
            </Box>
            <Box
              component="pre"
              data-testid="wechat-assistant-runtime-logs"
              sx={{
                mt: 0.85,
                mb: 0,
                p: 1,
                flex: 1,
                minHeight: 96,
                overflow: 'auto',
                bgcolor: '#f6f8fc',
                color: '#475569',
                border: '1px solid #e8edf6',
                borderRadius: SMALL_RADIUS,
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {diagnosticLines.length ? diagnosticLines.slice(-80).join('\n') : '暂无运行日志。'}
            </Box>
          </PanelCard>
        </Stack>

        <PanelCard
          title="个人微信绑定"
          action={<Chip size="small" label={loginConnected ? '已连接' : '未连接'} color={loginConnected ? 'success' : 'default'} variant="outlined" />}
          sx={{ display: 'flex', flexDirection: 'column' }}
        >
          <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 190, flex: 1, borderRadius: SMALL_RADIUS, bgcolor: '#f6f8fc', px: 1.5, textAlign: 'center' }}>
            {qrDataUrl ? (
              <Box component="img" src={qrDataUrl} alt="微信绑定二维码" sx={{ width: 190, height: 190, maxWidth: '100%' }} />
            ) : busy === 'start-login' || runtimeStatus?.login?.phase === 'starting' ? (
              <Stack alignItems="center" spacing={1}><CircularProgress size={28} /><Typography variant="caption">正在申请二维码…</Typography></Stack>
            ) : (
              <Box>
                <Typography variant="body2" fontWeight={850}>{loginConnected ? '个人微信已连接' : '扫码绑定个人微信'}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.45 }}>
                  {runtimeStatus?.login?.message || '先启用内置版，再生成二维码'}
                </Typography>
              </Box>
            )}
          </Box>

          {runtimeStatus?.login?.verifyCodeRequired ? (
            <Stack direction="row" spacing={1} mt={1}>
              <TextField size="small" fullWidth label="手机显示的数字" value={verifyCode} onChange={(event) => setVerifyCode(event.target.value.replace(/\D/g, '').slice(0, 8))} />
              <Button variant="contained" disabled={Boolean(busy) || !verifyCode} onClick={() => run('submit-verify-code', { code: verifyCode })}>提交</Button>
            </Stack>
          ) : null}

          <Stack direction="row" spacing={1} mt={1}>
            <Button variant="contained" fullWidth disabled={Boolean(busy) || !canActivate} onClick={() => run('start-login', { saveFirst: true })}>
              {loginConnected ? '重新绑定' : '生成绑定二维码'}
            </Button>
            {ACTIVE_LOGIN_PHASES.has(runtimeStatus?.login?.phase) ? <Button variant="outlined" color="inherit" onClick={() => run('cancel-login')}>取消</Button> : null}
          </Stack>
        </PanelCard>
      </Box>

      <WechatAssistantPermissionDialog
        open={permissionDialogOpen}
        value={allowedOperationActions}
        onClose={() => setPermissionDialogOpen(false)}
        onSave={(nextPermissions) => {
          setAllowedOperationActions(nextPermissions);
          setPermissionDialogOpen(false);
        }}
      />
    </Box>
  );
}

export { WechatAssistantSettingsPanel };
export default WechatAssistantSettingsPanel;
