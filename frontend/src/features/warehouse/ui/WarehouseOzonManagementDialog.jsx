import {
  getDeliveryMethodWriteEndpoint,
  isPausedRfbsWarehouse,
  isRfbsWarehouse,
  requestWarehouseWriteOperation,
} from '../services/warehouseWriteClient.js';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const ASSEMBLY_MINUTES = [15, 30, 60, 120, 180, 240, 300, 360, 420, 480];
const COURIER_CUTOFF_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40, 45];

function idOf(row = {}) {
  return String(row?.rawId || row?.id || '').trim();
}

function numberOrText(value) {
  const text = String(value || '').trim();
  const number = Number(text);
  return text && Number.isFinite(number) ? number : text;
}

function initialWarehouseDraft(warehouse = {}) {
  const source = warehouse || {};
  const raw = source.raw || {};
  return {
    name: source.name || raw.name || '',
    phone: raw.phone || '',
    isAutoAssembly: raw.is_auto_assembly === true,
    firstMileType: String(raw.first_mile?.type || '').toUpperCase(),
    dropOffPointId: raw.first_mile?.dropoff_point_id || '',
  };
}

function initialMethodDraft(method = {}) {
  const source = method || {};
  const raw = source.raw || {};
  const cutIn = Number(raw.cut_in);
  const courierCutoff = Number(raw.courier_cutoff);
  return {
    name: source.name || raw.name || '',
    cutIn: ASSEMBLY_MINUTES.includes(cutIn) ? String(cutIn) : '',
    courierCutoff: COURIER_CUTOFF_MINUTES.includes(courierCutoff) ? String(courierCutoff) : '',
  };
}

export function WarehouseOzonManagementDialog({
  open,
  shopId,
  warehouse,
  deliveryMethod = null,
  onClose,
  onCompleted,
}) {
  const methodMode = Boolean(deliveryMethod);
  const [warehouseDraft, setWarehouseDraft] = React.useState(() => initialWarehouseDraft(warehouse));
  const [methodDraft, setMethodDraft] = React.useState(() => initialMethodDraft(deliveryMethod));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setWarehouseDraft(initialWarehouseDraft(warehouse));
    setMethodDraft(initialMethodDraft(deliveryMethod));
    setBusy(false);
    setError('');
    setMessage('');
  }, [deliveryMethod, open, warehouse]);

  const execute = async (input) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await requestWarehouseWriteOperation({
        ...input,
        shopId,
        before: methodMode ? deliveryMethod?.raw : warehouse?.raw,
        realWrite: true,
        dryRun: false,
      }, { timeoutMs: 45_000 });
      setMessage(result.message || 'Ozon 仓库操作完成。');
      await onCompleted?.(result);
      return result;
    } catch (requestError) {
      setError(requestError?.message || 'Ozon 仓库操作失败。');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveWarehouse = () => {
    const rfbs = isRfbsWarehouse(warehouse);
    return execute({
      action: 'warehouse.update',
      endpointKey: rfbs ? 'warehouse.erfbsUpdate' : 'warehouse.fbsUpdate',
      payload: {
        warehouse_id: numberOrText(idOf(warehouse)),
        name: warehouseDraft.name.trim(),
        phone: warehouseDraft.phone.trim(),
        ...(rfbs
          ? { is_auto_assembly: warehouseDraft.isAutoAssembly }
          : { options: { is_auto_assembly: warehouseDraft.isAutoAssembly } }),
      },
    });
  };

  const saveFirstMile = () => execute({
    action: 'warehouse.first-mile.update',
    endpointKey: 'warehouse.fbsFirstMileUpdate',
    payload: {
      warehouse_id: numberOrText(idOf(warehouse)),
      first_mile_type: warehouseDraft.firstMileType,
      ...(warehouseDraft.firstMileType === 'DROP_OFF'
        ? { drop_off_point_id: numberOrText(warehouseDraft.dropOffPointId) }
        : {}),
    },
  });

  const toggleWarehouseAvailability = () => {
    const rfbs = isRfbsWarehouse(warehouse);
    const paused = isPausedRfbsWarehouse(warehouse);
    return execute(rfbs
      ? {
        action: paused ? 'warehouse.rfbs.unpause' : 'warehouse.rfbs.pause',
        endpointKey: paused ? 'warehouse.rfbsUnpause' : 'warehouse.rfbsPause',
        payload: { warehouse_id: numberOrText(idOf(warehouse)) },
      }
      : {
        action: /归档|archive|disabled/iu.test(String(warehouse.status || warehouse.raw?.status || ''))
          ? 'warehouse.unarchive'
          : 'warehouse.archive',
        endpointKey: /归档|archive|disabled/iu.test(String(warehouse.status || warehouse.raw?.status || ''))
          ? 'warehouse.unarchive'
          : 'warehouse.archive',
        payload: {
          warehouse_id: numberOrText(idOf(warehouse)),
          ...(/归档|archive|disabled/iu.test(String(warehouse.status || warehouse.raw?.status || ''))
            ? {}
            : { reason: '旺崽助手用户主动归档' }),
        },
      });
  };

  const saveDeliveryMethod = () => {
    const endpointKey = getDeliveryMethodWriteEndpoint(deliveryMethod);
    const aggregator = endpointKey === 'warehouse.erfbsAggregatorDeliveryMethodUpdate';
    return execute({
      action: 'delivery-method.update',
      endpointKey,
      payload: {
        warehouse_id: numberOrText(idOf(warehouse)),
        delivery_method_id: numberOrText(idOf(deliveryMethod)),
        name: methodDraft.name.trim(),
        ...(methodDraft.cutIn ? { cut_in: Number(methodDraft.cutIn) } : {}),
        ...(!aggregator && methodDraft.courierCutoff
          ? { courier_cutoff: Number(methodDraft.courierCutoff) }
          : {}),
      },
    });
  };

  const canSaveWarehouse = Boolean(warehouseDraft.name.trim() && warehouseDraft.phone.trim());
  const canSaveMethod = Boolean(methodDraft.name.trim());
  const paused = isPausedRfbsWarehouse(warehouse);
  const archived = /归档|archive|disabled/iu.test(String(warehouse?.status || warehouse?.raw?.status || ''));

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" data-testid="warehouse-ozon-management-dialog">
      <DialogTitle>{methodMode ? '修改 Ozon 配送方式' : '管理 Ozon 仓库'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="warning">
            这里会直接修改当前店铺的 Ozon 后台配置。提交后系统会等待 Ozon 操作状态，并重新读取仓库与配送方式。
          </Alert>
          <Typography variant="body2" color="text.secondary">
            店铺：{shopId || '未选择'} · 仓库：{warehouse?.name || '未选择'}（{idOf(warehouse) || '编号未返回'}）
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {message ? <Alert severity="success">{message}</Alert> : null}

          {methodMode ? (
            <>
              <TextField label="配送方式名称" value={methodDraft.name} onChange={(event) => setMethodDraft((current) => ({ ...current, name: event.target.value }))} />
              <TextField select label="订单备货时间" value={methodDraft.cutIn} onChange={(event) => setMethodDraft((current) => ({ ...current, cutIn: event.target.value }))}>
                <MenuItem value="">保持 Ozon 当前值</MenuItem>
                {ASSEMBLY_MINUTES.map((value) => <MenuItem key={value} value={String(value)}>{value} 分钟</MenuItem>)}
              </TextField>
              {getDeliveryMethodWriteEndpoint(deliveryMethod) === 'warehouse.erfbsNonIntegratedDeliveryMethodUpdate' ? (
                <TextField select label="交给快递员的时间" value={methodDraft.courierCutoff} onChange={(event) => setMethodDraft((current) => ({ ...current, courierCutoff: event.target.value }))}>
                  <MenuItem value="">保持 Ozon 当前值</MenuItem>
                  {COURIER_CUTOFF_MINUTES.map((value) => <MenuItem key={value} value={String(value)}>{value} 分钟</MenuItem>)}
                </TextField>
              ) : null}
            </>
          ) : (
            <>
              <TextField label="仓库名称" value={warehouseDraft.name} onChange={(event) => setWarehouseDraft((current) => ({ ...current, name: event.target.value }))} />
              <TextField label="仓库联系电话" value={warehouseDraft.phone} onChange={(event) => setWarehouseDraft((current) => ({ ...current, phone: event.target.value }))} />
              <FormControlLabel
                control={<Checkbox checked={warehouseDraft.isAutoAssembly} onChange={(event) => setWarehouseDraft((current) => ({ ...current, isAutoAssembly: event.target.checked }))} />}
                label="自动组装订单"
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField select fullWidth label="首公里方式" value={warehouseDraft.firstMileType} onChange={(event) => setWarehouseDraft((current) => ({ ...current, firstMileType: event.target.value }))}>
                  <MenuItem value="">暂不修改</MenuItem>
                  <MenuItem value="PICK_UP">快递员上门取件</MenuItem>
                  <MenuItem value="DROP_OFF">送到落货点</MenuItem>
                </TextField>
                {warehouseDraft.firstMileType === 'DROP_OFF' ? (
                  <TextField fullWidth label="Ozon 落货点 ID" value={warehouseDraft.dropOffPointId} onChange={(event) => setWarehouseDraft((current) => ({ ...current, dropOffPointId: event.target.value }))} />
                ) : null}
              </Stack>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {!methodMode ? (
          <>
            <Button color="warning" onClick={toggleWarehouseAvailability} disabled={busy}>
              {isRfbsWarehouse(warehouse) ? (paused ? '恢复仓库接单' : '暂停仓库接单') : (archived ? '恢复仓库' : '归档仓库')}
            </Button>
            <Button onClick={saveFirstMile} disabled={busy || !warehouseDraft.firstMileType || (warehouseDraft.firstMileType === 'DROP_OFF' && !warehouseDraft.dropOffPointId)}>
              保存首公里
            </Button>
          </>
        ) : null}
        <Button onClick={onClose} disabled={busy}>关闭</Button>
        <Button variant="contained" onClick={methodMode ? saveDeliveryMethod : saveWarehouse} disabled={busy || (methodMode ? !canSaveMethod : !canSaveWarehouse)}>
          {busy ? '正在提交并回读…' : methodMode ? '保存配送方式' : '保存仓库资料'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
