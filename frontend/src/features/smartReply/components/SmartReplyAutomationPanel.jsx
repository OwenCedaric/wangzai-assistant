import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded';
import ComputerRounded from '@mui/icons-material/ComputerRounded';
import LinkRounded from '@mui/icons-material/LinkRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const panelSx = {
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: '6px',
  bgcolor: 'background.paper',
};

function CredentialDialog({ automation, onClose, open }) {
  const missingShop = automation.form.shopClientIds.find(
    (clientId) => !automation.credentialsByClientId[clientId]?.configured
  );
  const [clientId, setClientId] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setClientId(missingShop || automation.form.shopClientIds[0] || automation.shopOptions[0]?.clientId || '');
  }, [automation.form.shopClientIds, automation.shopOptions, missingShop, open]);

  const submit = async () => {
    if (!clientId) return;
    const result = await automation.configureCredential(clientId);
    if (result) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" PaperProps={{ sx: { borderRadius: '6px' } }}>
      <DialogTitle>接入自动发送店铺</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            将直接使用此电脑已绑定的店铺授权同步到云端；无需再次填写 API Key。同步后，电脑关机或退出软件时，云端仍可按已开启规则执行。
          </Typography>
          <FormControl size="small" fullWidth>
            <InputLabel>Ozon 店铺</InputLabel>
            <Select label="Ozon 店铺" value={clientId} onChange={(event) => setClientId(event.target.value)}>
              {automation.shopOptions.map((shop) => (
                <MenuItem key={shop.clientId} value={shop.clientId}>
                  {shop.name}（{shop.clientId}）
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          disabled={!clientId || automation.busyAction === 'credential'}
          onClick={submit}
          sx={{ borderRadius: '6px !important' }}
        >
          {automation.busyAction === 'credential' ? '正在同步' : '同步并接入'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function SmartReplyAutomationPanel({ automation, sceneTitle = '' }) {
  const [credentialOpen, setCredentialOpen] = React.useState(false);
  const isLocalMode = automation.executionMode === 'local';
  const selectedNames = automation.form.shopClientIds
    .map((clientId) => automation.shopOptions.find((shop) => shop.clientId === clientId)?.name || clientId)
    .join('、');
  const selectedReady =
    automation.form.shopClientIds.length > 0 &&
    automation.form.shopClientIds.every(
      (clientId) =>
        automation.credentialsByClientId[clientId]?.configured &&
        automation.credentialsByClientId[clientId]?.status === 'active'
    );
  const toggleRule = (nextEnabled) => {
    if (nextEnabled && !selectedReady && !isLocalMode) {
      setCredentialOpen(true);
      return;
    }
    void automation.setRuleEnabled(nextEnabled);
  };

  return (
    <Stack spacing={1.5}>
      <Box sx={{ ...panelSx, p: 2 }}>
        <Stack direction={{ xs: 'column', xl: 'row' }} spacing={2} alignItems={{ xl: 'center' }}>
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 250 }}>
            {isLocalMode ? (
              <ComputerRounded color={automation.runtime.workerRunning ? 'primary' : 'disabled'} />
            ) : (
              <CloudDoneRounded color={automation.runtime.workerRunning ? 'primary' : 'disabled'} />
            )}
            <Box>
              <Typography variant="subtitle1" fontWeight={800}>自动发送任务</Typography>
              <Typography variant="caption" color="text.secondary">
                {automation.currentRule?.enabled
                  ? `${sceneTitle}规则正在生效`
                  : automation.runtime.workerRunning && (isLocalMode ? automation.runtime.pollingActive : automation.runtime.callbackConfigured)
                    ? `设置${sceneTitle}的发送方式`
                    : '自动发送服务尚未就绪'}
              </Typography>
            </Box>
            <Switch
              checked={automation.currentRule?.enabled === true}
              disabled={Boolean(automation.busyAction)}
              onChange={(event) => toggleRule(event.target.checked)}
              inputProps={{ 'aria-label': `${sceneTitle}自动发送开关` }}
            />
          </Stack>

          <FormControl size="small" sx={{ minWidth: 170 }}>
            <InputLabel id="smart-reply-execution-mode-label">执行模式</InputLabel>
            <Select
              labelId="smart-reply-execution-mode-label"
              label="执行模式"
              value={automation.executionMode}
              disabled={Boolean(automation.busyAction)}
              onChange={(event) => void automation.setExecutionMode(event.target.value)}
            >
              <MenuItem value="local">本地模式</MenuItem>
              <MenuItem value="cloud">云端模式</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 260, flex: 1 }}>
            <InputLabel>生效店铺</InputLabel>
            <Select
              multiple
              label="生效店铺"
              value={automation.form.shopClientIds}
              renderValue={() => selectedNames || '请选择店铺'}
              onChange={(event) => automation.updateForm({ shopClientIds: event.target.value })}
            >
              {automation.shopOptions.map((shop) => (
                <MenuItem key={shop.clientId} value={shop.clientId}>
                  <Checkbox checked={automation.form.shopClientIds.includes(shop.clientId)} size="small" />
                  {shop.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 170 }}>
            <InputLabel>发送时间</InputLabel>
            <Select
              label="发送时间"
              value={automation.form.sendTimeType}
              onChange={(event) => automation.updateForm({ sendTimeType: event.target.value })}
            >
              <MenuItem value="immediate">状态更新后立即发送</MenuItem>
              <MenuItem value="delayed">状态更新后延时发送</MenuItem>
            </Select>
          </FormControl>

          {automation.form.sendTimeType === 'delayed' ? (
            <TextField
              label="延时小时"
              size="small"
              type="number"
              value={automation.form.delayHours}
              onChange={(event) => automation.updateForm({ delayHours: Math.min(72, Math.max(1, Number(event.target.value) || 1)) })}
              inputProps={{ min: 1, max: 72 }}
              sx={{ width: 120 }}
            />
          ) : null}

          <Stack direction="row" spacing={1}>
            {isLocalMode ? (
              <Button
                startIcon={<ComputerRounded />}
                variant="text"
                disabled={!selectedReady}
                sx={{ borderRadius: '6px !important' }}
              >
                {selectedReady ? '使用本地授权' : '店铺授权不可用'}
              </Button>
            ) : (
              <Button
                startIcon={<LinkRounded />}
                variant={selectedReady ? 'text' : 'outlined'}
                onClick={() => setCredentialOpen(true)}
                sx={{ borderRadius: '6px !important' }}
              >
                {selectedReady ? '店铺已接入' : '接入店铺'}
              </Button>
            )}
            <Button
              variant="contained"
              disabled={automation.busyAction === 'save' || !automation.form.shopClientIds.length}
              onClick={() => void automation.saveRule().catch(() => undefined)}
              sx={{ borderRadius: '6px !important' }}
            >
              保存规则
            </Button>
          </Stack>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          {isLocalMode
            ? '本地模式在电脑和软件运行时监听订单并发送；固定或自定义模板不调用模型，不消耗模型积分。'
            : '云端模式由服务器持续执行，电脑关机或退出软件后仍可按已开启规则发送。'}
        </Typography>

        {automation.error ? (
          <Typography variant="body2" color="error" sx={{ mt: 1.5 }}>{automation.error}</Typography>
        ) : automation.notice ? (
          <Typography variant="body2" color="primary" sx={{ mt: 1.5 }}>{automation.notice}</Typography>
        ) : null}
      </Box>

      <CredentialDialog
        automation={automation}
        open={!isLocalMode && credentialOpen}
        onClose={() => setCredentialOpen(false)}
      />
    </Stack>
  );
}
