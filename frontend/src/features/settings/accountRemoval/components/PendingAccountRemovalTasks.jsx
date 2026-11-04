import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { listPendingAccountRemovals } from '../services/accountRemovalClient.js';
import { useAccountRemovalFlow } from '../model/useAccountRemovalFlow.js';
import { accountRemovalOwnerLabels, getAccountRemovalErrorMessage, getAccountRemovalPhaseLabel } from '../lib/accountRemovalPresentation.js';
import { AccountRemovalPreviewDialog } from './AccountRemovalPreviewDialog.jsx';

function submittedAt(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '提交时间未提供';
}

export function PendingAccountRemovalTasks({ read = listPendingAccountRemovals } = {}) {
  const removal = useAccountRemovalFlow();
  const [expanded, setExpanded] = React.useState(false);
  const [state, setState] = React.useState({ status: 'idle', rows: [], error: '' });
  const [continuingId, setContinuingId] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const generationRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  const controllerRef = React.useRef(null);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); generationRef.current += 1; };
  }, []);
  const reload = React.useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    setState(current => ({ ...current, status: 'loading', error: '' }));
    try {
      const payload = await read({ signal: controller.signal });
      if (controller.signal.aborted || generation !== generationRef.current) return;
      if (payload?.ok === false || !Array.isArray(payload?.operations)) throw new Error('未完成删除列表返回无效数据。');
      if (payload.operations.some(operation => !operation || typeof operation !== 'object' || !operation.operationId)) throw new Error('未完成删除列表包含无效任务。');
      const rows = payload.operations.filter(operation => operation.completed !== true).map(operation => ({
        ...operation, recoveryUnavailable: operation.recoveryUnavailable === true
          || !Object.hasOwn(accountRemovalOwnerLabels, operation.pendingOwner?.ownerType) || !operation.pendingOwner?.ownerId,
      }));
      setState({ status: 'ready', rows, error: '' });
    } catch (error) {
      if (!controller.signal.aborted && generation === generationRef.current) setState(current => ({
        ...current, status: 'error', error: `未完成删除列表读取失败。${getAccountRemovalErrorMessage(error)}`,
      }));
    }
  }, [read]);
  const resume = async operation => {
    if (continuingId || operation.recoveryUnavailable) return;
    setContinuingId(operation.operationId); setNotice('');
    try {
      const result = await removal.resumePendingOperation(operation);
      if (mountedRef.current && result?.completed) await reload();
    } catch (error) {
      if (mountedRef.current) setNotice(getAccountRemovalErrorMessage(error));
    } finally { if (mountedRef.current) setContinuingId(''); }
  };
  return (
    <Box sx={{ mt: 1 }}>
      <Button size="small" onClick={() => { setExpanded(current => !current); if (!expanded) void reload(); }}>
        {expanded ? '收起未完成删除' : '查看 / 继续未完成删除'}
      </Button>
      {expanded && <Stack spacing={1} sx={{ mt: 1, maxHeight: 240, overflowY: 'auto' }}>
        <Typography variant="caption">这里只读取已有删除任务；点击“继续”才会恢复对应任务，不会重新创建删除。</Typography>
        {state.status === 'loading' && <Typography role="status" variant="body2">正在读取未完成删除…</Typography>}
        {state.status === 'error' && <Alert severity="warning" action={<Button onClick={reload}>重新读取</Button>}>{state.error}</Alert>}
        {notice && <Alert severity="warning">{notice}</Alert>}
        {state.status === 'ready' && state.rows.length === 0 && <Typography variant="body2">没有未完成的删除任务。</Typography>}
        {state.rows.map(operation => <Stack key={operation.operationId} direction="row" spacing={1} alignItems="center" sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2">{accountRemovalOwnerLabels[operation.pendingOwner?.ownerType || operation.ownerType] || '账号'} · {getAccountRemovalPhaseLabel(operation.phase)}</Typography>
            <Typography variant="caption" color="text.secondary">{submittedAt(operation.createdAt || operation.submittedAt)} · {operation.operationId}</Typography>
            {operation.recoveryUnavailable && <Typography variant="body2" color="error">恢复信息缺失，不能安全继续。</Typography>}
            {!operation.recoveryUnavailable && operation.error?.code && <Typography variant="caption" color="warning.main"
              data-account-removal-error-code={operation.error.code}>{getAccountRemovalErrorMessage({ code: operation.error.code })}</Typography>}
          </Box>
          <Button size="small" disabled={Boolean(continuingId) || operation.recoveryUnavailable === true || !operation.pendingOwner}
            onClick={() => void resume(operation)} aria-label={`继续删除任务 ${operation.operationId}`}>
            {continuingId === operation.operationId ? '处理中…' : '继续'}
          </Button>
        </Stack>)}
      </Stack>}
      <AccountRemovalPreviewDialog flow={removal.flow} busy={removal.busy} onConfirm={removal.confirmRemoval}
        onRefresh={async () => {
          try {
            if (removal.flow.operation?.operationId) await removal.resumePendingOperation({ ...removal.flow.operation,
              pendingOwner: removal.flow.owner, pendingOwnerGeneration: removal.flow.ownerGeneration });
          } catch (error) { if (mountedRef.current) setNotice(getAccountRemovalErrorMessage(error)); }
        }} onClose={removal.closeAccountRemoval} />
    </Box>
  );
}
