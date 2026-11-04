import {
  getWarehouseReferenceRows,
  requestWarehouseReferenceData,
  requestWarehouseWriteOperation,
} from '../services/warehouseWriteClient.js';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const DAYS = [
  ['MONDAY', '周一'], ['TUESDAY', '周二'], ['WEDNESDAY', '周三'], ['THURSDAY', '周四'],
  ['FRIDAY', '周五'], ['SATURDAY', '周六'], ['SUNDAY', '周日'],
];
const ASSEMBLY_MINUTES = [15, 30, 60, 120, 180, 240, 300, 360, 420, 480];
const COURIER_CUTOFF_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40, 45];
const DELIVERY_TIMES = [15, 30, 45, 60, 90, 120, 150];

function initialDraft() {
  return {
    mode: 'erfbs-aggregator',
    name: '', phone: '', latitude: '', longitude: '', isAutoAssembly: false,
    workDays: DAYS.slice(0, 5).map(([value]) => value), workFrom: '09:00', workTo: '18:00',
    minOrderValue: '', deliveryName: '', cutIn: '120', courierCutoff: '15',
    courierComment: '', courierPhones: '', deliverToPvz: false,
    deliveryMinAmount: '', deliveryMaxAmount: '', deliveryPercent: '',
    returnMethod: 'UNSPECIFIED', returnContactDays: '', returnZipcode: '', transportCompanyName: '',
    polygonIds: '', polygonTime: '60', polygonCoordinates: '',
    countryCode: 'CN', addressSearch: '', isKgt: false, firstMileType: 'DROP_OFF',
    dropOffPointId: '', timeslotId: '', returnPointId: '',
  };
}

function numberValue(value) {
  const text = String(value || '').trim();
  const number = Number(text);
  return text && Number.isFinite(number) ? number : undefined;
}

function optionalObject(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
}

function timetable(draft) {
  return {
    holidays: [],
    working_days: draft.workDays.map((day) => ({ day, from: draft.workFrom, to: draft.workTo })),
  };
}

function returnSettings(draft) {
  return optionalObject({
    return_method: draft.returnMethod,
    contact_days: numberValue(draft.returnContactDays),
    post_office_zipcode: draft.returnZipcode.trim(),
    transport_company_name: draft.transportCompanyName.trim(),
  });
}

export function buildWarehouseCreateWrite(draft) {
  const coordinates = { latitude: Number(draft.latitude), longitude: Number(draft.longitude) };
  if (draft.mode === 'fbs') {
    return {
      action: 'warehouse.create.fbs',
      endpointKey: 'warehouse.fbsCreate',
      payload: optionalObject({
        address_coordinates: coordinates,
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        is_kgt: draft.isKgt,
        first_mile_type: draft.firstMileType,
        drop_off_point_id: draft.firstMileType === 'DROP_OFF' ? numberValue(draft.dropOffPointId) : undefined,
        timeslot_id: numberValue(draft.timeslotId),
        return_point_id: numberValue(draft.returnPointId),
        working_days: draft.workDays,
        options: {
          is_auto_assembly: draft.isAutoAssembly,
          courier_phones: draft.courierPhones.trim() ? [draft.courierPhones.trim()] : [],
          comment: draft.courierComment.trim(),
        },
      }),
    };
  }
  const shared = optionalObject({
    address_coordinates: coordinates,
    is_auto_assembly: draft.isAutoAssembly,
    min_order_value: numberValue(draft.minOrderValue),
    name: draft.name.trim(),
    phone: draft.phone.trim(),
    timetable_warehouse: timetable(draft),
  });
  if (draft.mode === 'erfbs-non-integrated') {
    const polygonIds = draft.polygonIds.split(/[,，\s]+/u).map(numberValue).filter(Number.isFinite);
    return {
      action: 'warehouse.create.erfbs-non-integrated',
      endpointKey: 'warehouse.erfbsNonIntegratedCreate',
      payload: {
        ...shared,
        delivery_method: optionalObject({
          name: draft.deliveryName.trim(),
          cut_in: numberValue(draft.cutIn),
          courier_cutoff: numberValue(draft.courierCutoff),
          delivery_polygons: polygonIds.map((id) => ({ id, time: numberValue(draft.polygonTime) })),
          return_settings: returnSettings(draft),
        }),
      },
    };
  }
  return {
    action: 'warehouse.create.erfbs-aggregator',
    endpointKey: 'warehouse.erfbsAggregatorCreate',
    payload: {
      ...shared,
      delivery_method: optionalObject({
        name: draft.deliveryName.trim(),
        cut_in: numberValue(draft.cutIn),
        deliver_to_pvz: draft.deliverToPvz,
        courier_comment: draft.courierComment.trim(),
        courier_phones: draft.courierPhones.trim() ? [draft.courierPhones.trim()] : [],
        delivery_costs: optionalObject({
          min_amount: numberValue(draft.deliveryMinAmount),
          max_amount: numberValue(draft.deliveryMaxAmount),
          percent: numberValue(draft.deliveryPercent),
        }),
        return_settings: returnSettings(draft),
      }),
    },
  };
}

export function WarehouseOzonCreateDialog({ open, shop, onClose, onCompleted }) {
  const [draft, setDraft] = React.useState(initialDraft);
  const [dropOffPoints, setDropOffPoints] = React.useState([]);
  const [timeslots, setTimeslots] = React.useState([]);
  const [returnPoints, setReturnPoints] = React.useState([]);
  const [loadingReferences, setLoadingReferences] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [creatingPolygon, setCreatingPolygon] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setDraft(initialDraft());
    setDropOffPoints([]);
    setTimeslots([]);
    setReturnPoints([]);
    setLoadingReferences(false);
    setBusy(false);
    setCreatingPolygon(false);
    setError('');
    setMessage('');
  }, [open]);

  const change = (field) => (event) => {
    const value = event?.target?.type === 'checkbox' ? event.target.checked : event.target.value;
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const searchFbsReferences = async () => {
    setLoadingReferences(true);
    setError('');
    try {
      const coordinates = { latitude: Number(draft.latitude), longitude: Number(draft.longitude) };
      if (draft.firstMileType === 'DROP_OFF') {
        const dropOffPayload = await requestWarehouseReferenceData({
          shop,
          endpoint: '/v1/warehouse/fbs/create/drop-off/list',
          body: {
            country_code: draft.countryCode.trim().toUpperCase(),
            is_kgt: draft.isKgt,
            coordinates,
            search: { address: draft.addressSearch.trim(), types: ['PVZ', 'PPZ', 'SC'] },
          },
        }, { timeoutMs: 30_000 });
        setDropOffPoints(getWarehouseReferenceRows(dropOffPayload, 'points'));
      } else {
        const pickupPayload = await requestWarehouseReferenceData({
          shop,
          endpoint: '/v1/warehouse/fbs/create/pick-up/timeslot/list',
          body: { address_coordinates: coordinates, is_kgt: draft.isKgt },
        }, { timeoutMs: 30_000 });
        setTimeslots(getWarehouseReferenceRows(pickupPayload, 'timeslots'));
      }
    } catch (requestError) {
      setError(requestError?.message || 'Ozon 仓库可选项读取失败。');
    } finally {
      setLoadingReferences(false);
    }
  };

  const loadDropOffDetails = async (pointId) => {
    setDraft((current) => ({ ...current, dropOffPointId: pointId, timeslotId: '', returnPointId: '' }));
    if (!pointId) return;
    setLoadingReferences(true);
    setError('');
    try {
      const coordinates = { latitude: Number(draft.latitude), longitude: Number(draft.longitude) };
      const [timeslotPayload, returnPayload] = await Promise.all([
        requestWarehouseReferenceData({
          shop,
          endpoint: '/v1/warehouse/fbs/create/drop-off/timeslot/list',
          body: { drop_off_point_id: numberValue(pointId) },
        }, { timeoutMs: 30_000 }),
        requestWarehouseReferenceData({
          shop,
          endpoint: '/v1/warehouse/fbs/create/return-point/list',
          body: {
            coordinates,
            country_code: draft.countryCode.trim().toUpperCase(),
            limit: 50,
            search: { address: draft.addressSearch.trim(), types: ['PVZ', 'PPZ', 'SC'] },
            selected_dropoff_point_id: numberValue(pointId),
          },
        }, { timeoutMs: 30_000 }),
      ]);
      setTimeslots(getWarehouseReferenceRows(timeslotPayload, 'timeslots'));
      setReturnPoints(getWarehouseReferenceRows(returnPayload, 'points'));
    } catch (requestError) {
      setError(requestError?.message || '落货点时段或退货点读取失败。');
    } finally {
      setLoadingReferences(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const write = buildWarehouseCreateWrite(draft);
      const result = await requestWarehouseWriteOperation({
        ...write,
        shopId: shop?.id || '',
        before: null,
        after: write.payload,
        realWrite: true,
        dryRun: false,
        requestedBy: 'warehouse-create-dialog',
      }, { timeoutMs: 60_000 });
      setMessage(result.message || 'Ozon 仓库创建已提交并回读。');
      await onCompleted?.(result);
    } catch (requestError) {
      setError(requestError?.message || 'Ozon 仓库创建失败。');
    } finally {
      setBusy(false);
    }
  };

  const createPolygon = async () => {
    setCreatingPolygon(true);
    setError('');
    setMessage('');
    try {
      const coordinates = JSON.parse(draft.polygonCoordinates);
      if (!Array.isArray(coordinates) || !coordinates.length) throw new Error('配送区域坐标必须是非空 JSON 数组。');
      const result = await requestWarehouseWriteOperation({
        shopId: shop?.id || '',
        action: 'delivery-polygon.create',
        endpointKey: 'warehouse.polygonCreate',
        payload: { coordinates: JSON.stringify(coordinates) },
        before: null,
        realWrite: true,
        dryRun: false,
        requestedBy: 'warehouse-create-dialog',
      }, { timeoutMs: 45_000 });
      const polygonId = result?.data?.polygon_id
        ?? result?.data?.polygonId
        ?? result?.schedulerResult?.data?.polygon_id
        ?? result?.schedulerResult?.data?.polygonId;
      if (!polygonId) throw new Error('Ozon 已接收配送区域，但没有返回 Polygon ID。');
      setDraft((current) => ({
        ...current,
        polygonIds: [...new Set([
          ...current.polygonIds.split(/[,，\s]+/u).filter(Boolean),
          String(polygonId),
        ])].join(', '),
      }));
      setMessage(`配送区域已创建，Polygon ID：${polygonId}`);
    } catch (requestError) {
      setError(requestError?.message || 'Ozon 配送区域创建失败。');
    } finally {
      setCreatingPolygon(false);
    }
  };

  const coordinatesReady = Number.isFinite(Number(draft.latitude)) && Number.isFinite(Number(draft.longitude));
  const basicReady = Boolean(draft.name.trim() && draft.phone.trim() && coordinatesReady && draft.workDays.length);
  const fbsReady = draft.mode !== 'fbs' || Boolean(
    draft.firstMileType
      && (draft.firstMileType !== 'DROP_OFF' || (draft.dropOffPointId && draft.timeslotId))
  );
  const deliveryReady = draft.mode === 'fbs' || Boolean(draft.deliveryName.trim() && draft.cutIn);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md" data-testid="warehouse-ozon-create-dialog">
      <DialogTitle>新建 Ozon 仓库与配送方式</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="warning">提交后会在当前店铺真实创建仓库。rFBS 的新配送方式由 Ozon 创建接口与新仓库一起创建。</Alert>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {message ? <Alert severity="success">{message}</Alert> : null}
          <TextField select label="创建类型" value={draft.mode} onChange={change('mode')}>
            <MenuItem value="fbs">FBS 仓库</MenuItem>
            <MenuItem value="erfbs-aggregator">rFBS · Ozon合作伙伴配送</MenuItem>
            <MenuItem value="erfbs-non-integrated">rFBS · 卖家/第三方配送</MenuItem>
          </TextField>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField fullWidth label="仓库名称" value={draft.name} onChange={change('name')} />
            <TextField fullWidth label="联系电话" value={draft.phone} onChange={change('phone')} />
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField fullWidth label="纬度" value={draft.latitude} onChange={change('latitude')} inputProps={{ inputMode: 'decimal' }} />
            <TextField fullWidth label="经度" value={draft.longitude} onChange={change('longitude')} inputProps={{ inputMode: 'decimal' }} />
            <TextField fullWidth label="最低订单金额" value={draft.minOrderValue} onChange={change('minOrderValue')} inputProps={{ inputMode: 'numeric' }} />
          </Stack>
          <FormControlLabel control={<Checkbox checked={draft.isAutoAssembly} onChange={change('isAutoAssembly')} />} label="自动组装订单" />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <FormControl fullWidth>
              <InputLabel>工作日</InputLabel>
              <Select multiple label="工作日" value={draft.workDays} onChange={change('workDays')} renderValue={(selected) => selected.map((value) => DAYS.find(([key]) => key === value)?.[1]).filter(Boolean).join('、')}>
                {DAYS.map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    <Checkbox checked={draft.workDays.includes(value)} />
                    <ListItemText primary={label} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField fullWidth label="开始营业" type="time" value={draft.workFrom} onChange={change('workFrom')} InputLabelProps={{ shrink: true }} />
            <TextField fullWidth label="结束营业" type="time" value={draft.workTo} onChange={change('workTo')} InputLabelProps={{ shrink: true }} />
          </Stack>

          {draft.mode === 'fbs' ? (
            <>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <TextField select fullWidth label="首公里方式" value={draft.firstMileType} onChange={change('firstMileType')}>
                  <MenuItem value="DROP_OFF">送到落货点</MenuItem>
                  <MenuItem value="PICK_UP">快递员上门取件</MenuItem>
                </TextField>
                <TextField fullWidth label="国家代码" value={draft.countryCode} onChange={change('countryCode')} />
                <TextField fullWidth label="地址关键词" value={draft.addressSearch} onChange={change('addressSearch')} />
                <FormControlLabel control={<Checkbox checked={draft.isKgt} onChange={change('isKgt')} />} label="大件仓" />
              </Stack>
              <Button variant="outlined" onClick={searchFbsReferences} disabled={loadingReferences || !coordinatesReady}>
                {loadingReferences ? '正在读取 Ozon 可选项…' : '读取落货点/取件时段'}
              </Button>
              {draft.firstMileType === 'DROP_OFF' ? (
                <TextField select label="落货点" value={draft.dropOffPointId} onChange={(event) => loadDropOffDetails(event.target.value)}>
                  <MenuItem value="">请选择</MenuItem>
                  {dropOffPoints.map((point) => <MenuItem key={point.id} value={String(point.id)}>{point.address || point.name || point.id}</MenuItem>)}
                </TextField>
              ) : null}
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <TextField select fullWidth label="交货时段" value={draft.timeslotId} onChange={change('timeslotId')}>
                  <MenuItem value="">请选择</MenuItem>
                  {timeslots.map((slot) => <MenuItem key={slot.id} value={String(slot.id)}>{slot.from || slot.acceptance_start_time_local || slot.id} - {slot.to || slot.acceptance_end_time_local || ''}</MenuItem>)}
                </TextField>
                <TextField select fullWidth label="退货点" value={draft.returnPointId} onChange={change('returnPointId')}>
                  <MenuItem value="">暂不选择</MenuItem>
                  {returnPoints.map((point) => <MenuItem key={point.id} value={String(point.id)}>{point.name || point.address || point.id}</MenuItem>)}
                </TextField>
              </Stack>
            </>
          ) : (
            <>
              <TextField label="配送方式名称" value={draft.deliveryName} onChange={change('deliveryName')} />
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <TextField select fullWidth label="备货时间" value={draft.cutIn} onChange={change('cutIn')}>
                  {ASSEMBLY_MINUTES.map((value) => <MenuItem key={value} value={String(value)}>{value} 分钟</MenuItem>)}
                </TextField>
                {draft.mode === 'erfbs-non-integrated' ? (
                  <TextField select fullWidth label="交给快递员时间" value={draft.courierCutoff} onChange={change('courierCutoff')}>
                    {COURIER_CUTOFF_MINUTES.map((value) => <MenuItem key={value} value={String(value)}>{value} 分钟</MenuItem>)}
                  </TextField>
                ) : null}
              </Stack>
              {draft.mode === 'erfbs-aggregator' ? (
                <>
                  <FormControlLabel control={<Checkbox checked={draft.deliverToPvz} onChange={change('deliverToPvz')} />} label="允许配送到自提点" />
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    <TextField fullWidth label="最低配送费" value={draft.deliveryMinAmount} onChange={change('deliveryMinAmount')} />
                    <TextField fullWidth label="最高配送费" value={draft.deliveryMaxAmount} onChange={change('deliveryMaxAmount')} />
                    <TextField fullWidth label="订单金额百分比" value={draft.deliveryPercent} onChange={change('deliveryPercent')} />
                  </Stack>
                </>
              ) : (
                <Stack spacing={1}>
                  <TextField
                    fullWidth
                    multiline
                    minRows={2}
                    label="配送区域坐标 JSON"
                    placeholder="[[[29.30,120.10],[29.31,120.10],[29.31,120.11],[29.30,120.10]]]"
                    value={draft.polygonCoordinates}
                    onChange={change('polygonCoordinates')}
                  />
                  <Button variant="outlined" onClick={createPolygon} disabled={creatingPolygon || !draft.polygonCoordinates.trim()}>
                    {creatingPolygon ? '正在创建配送区域…' : '创建配送区域并带入 Polygon ID'}
                  </Button>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    <TextField fullWidth label="配送区域 Polygon ID（逗号分隔）" value={draft.polygonIds} onChange={change('polygonIds')} />
                    <TextField select fullWidth label="区域配送时间" value={draft.polygonTime} onChange={change('polygonTime')}>
                      {DELIVERY_TIMES.map((value) => <MenuItem key={value} value={String(value)}>{value} 分钟</MenuItem>)}
                    </TextField>
                  </Stack>
                </Stack>
              )}
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <TextField fullWidth label="快递员备注" value={draft.courierComment} onChange={change('courierComment')} />
                <TextField fullWidth label="快递员联系电话" value={draft.courierPhones} onChange={change('courierPhones')} />
              </Stack>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <TextField select fullWidth label="退货方式" value={draft.returnMethod} onChange={change('returnMethod')}>
                  <MenuItem value="UNSPECIFIED">不指定</MenuItem>
                  <MenuItem value="COURIER">快递员取回</MenuItem>
                  <MenuItem value="TRANSPORT_COMPANY">运输公司退回</MenuItem>
                </TextField>
                <TextField fullWidth label="联系天数" value={draft.returnContactDays} onChange={change('returnContactDays')} />
                <TextField fullWidth label="退货邮编" value={draft.returnZipcode} onChange={change('returnZipcode')} />
                <TextField fullWidth label="运输公司" value={draft.transportCompanyName} onChange={change('transportCompanyName')} />
              </Stack>
            </>
          )}
          <Typography variant="caption" color="text.secondary">当前店铺：{shop?.shopAlias || shop?.name || shop?.id || '未选择'}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy || creatingPolygon}>关闭</Button>
        <Button variant="contained" onClick={submit} disabled={busy || creatingPolygon || !basicReady || !fbsReady || !deliveryReady}>
          {busy ? '正在创建并回读…' : '提交创建'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
