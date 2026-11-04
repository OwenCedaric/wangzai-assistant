import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import { formatCollectionShopLabel, getCollectionShopId } from '../lib/collectionShopLabel.js';

function warehouseIdOf(warehouse = {}) {
  return String(warehouse.rawId || warehouse.id || '').trim();
}

function shopIdOf(shop = {}) {
  return getCollectionShopId(shop);
}

function shopLabel(shop = {}, fallbackShopId = '') {
  return formatCollectionShopLabel(shop, fallbackShopId);
}

export function CollectionProductBatchStockDialog({
  open = false,
  shops = [],
  selectedShopIds = [],
  warehousesByShopId = {},
  warehouseStatesByShopId = {},
  enabledSkuCount = 0,
  defaultInventoryByShopId = {},
  onClose,
  onReload,
  onApply,
}) {
  const shopById = React.useMemo(
    () => new Map(shops.map((shop) => [shopIdOf(shop), shop])),
    [shops],
  );
  const [inventoryByShopId, setInventoryByShopId] = React.useState({});
  const [error, setError] = React.useState('');
  const [applying, setApplying] = React.useState(false);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    setInventoryByShopId((current) => Object.fromEntries(selectedShopIds.map((shopId) => {
      const normalizedShopId = String(shopId || '').trim();
      const warehouses = warehousesByShopId[normalizedShopId] || [];
      const existing = opening ? {} : (current[normalizedShopId] || {});
      const preferredWarehouseId = String(defaultInventoryByShopId[normalizedShopId]?.warehouseId || '').trim();
      const warehouseId = warehouses.some((item) => warehouseIdOf(item) === existing.warehouseId)
        ? existing.warehouseId
        : warehouses.some((item) => warehouseIdOf(item) === preferredWarehouseId)
          ? preferredWarehouseId
          : warehouseIdOf(warehouses[0]);
      return [normalizedShopId, {
        warehouseId,
        stock: existing.stock ?? String(defaultInventoryByShopId[normalizedShopId]?.stock ?? ''),
      }];
    })));
    if (opening) {
      setError('');
      setApplying(false);
    }
  }, [defaultInventoryByShopId, open, selectedShopIds, warehousesByShopId]);

  const updateInventory = (shopId, changes) => {
    setInventoryByShopId((current) => ({
      ...current,
      [shopId]: { ...(current[shopId] || {}), ...changes },
    }));
    setError('');
  };

  const apply = async () => {
    if (!selectedShopIds.length) {
      setError('请先选择要上架的店铺。');
      return;
    }
    const shopInventories = [];
    for (const rawShopId of selectedShopIds) {
      const shopId = String(rawShopId || '').trim();
      const inventory = inventoryByShopId[shopId] || {};
      const normalizedStockText = String(inventory.stock ?? '').trim();
      const normalizedStock = Number(normalizedStockText);
      if (!inventory.warehouseId) {
        setError(`请选择“${shopLabel(shopById.get(shopId), shopId)}”要写入的 Ozon 仓库。`);
        return;
      }
      if (!normalizedStockText || !Number.isSafeInteger(normalizedStock) || normalizedStock < 0) {
        setError(`“${shopLabel(shopById.get(shopId), shopId)}”的库存必须是大于或等于 0 的整数。`);
        return;
      }
      shopInventories.push({ shopId, warehouseId: inventory.warehouseId, stock: normalizedStock });
    }
    setApplying(true);
    setError('');
    try {
      const result = await Promise.resolve(onApply?.({ shopInventories }));
      if (result?.ok === false) {
        setError(result.error || '库存批量填写失败。');
        return;
      }
      onClose?.();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : '库存批量填写失败。');
    } finally {
      setApplying(false);
    }
  };

  const anyLoading = selectedShopIds.some((shopId) => warehouseStatesByShopId[shopId]?.status === 'loading');
  const allWarehousesReady = selectedShopIds.length > 0 && selectedShopIds.every((shopId) => (
    warehouseStatesByShopId[shopId]?.status === 'ready' && (warehousesByShopId[shopId] || []).length > 0
  ));

  return (
    <Dialog open={open} onClose={applying ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ fontWeight: 850, pb: 1 }}>按店铺批量设置库存</DialogTitle>
      <DialogContent>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            已选择 {selectedShopIds.length} 家店铺；每家店铺独立读取自己的仓库并保存库存，将应用到 {enabledSkuCount} 个已启用 SKU。
          </Typography>
          {!selectedShopIds.length ? <Alert severity="warning">请先关闭弹窗并选择上传店铺。</Alert> : null}
          {selectedShopIds.map((shopId) => {
            const normalizedShopId = String(shopId || '').trim();
            const warehouses = warehousesByShopId[normalizedShopId] || [];
            const warehouseState = warehouseStatesByShopId[normalizedShopId] || {};
            const inventory = inventoryByShopId[normalizedShopId] || {};
            const loading = warehouseState.status === 'loading';
            return (
              <Paper key={normalizedShopId} variant="outlined" sx={{ p: 1.25, borderRadius: 1, borderColor: '#e1e6ef' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'center' }} spacing={1}>
                  <Box sx={{ width: { md: 240 }, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={800} noWrap title={shopLabel(shopById.get(normalizedShopId), normalizedShopId)}>
                      {shopLabel(shopById.get(normalizedShopId), normalizedShopId)}
                    </Typography>
                    <Typography variant="caption" color={warehouseState.error ? 'error.main' : 'text.secondary'}>
                      {loading ? '正在读取该店仓库…' : warehouseState.error || `已读取 ${warehouses.length} 个仓库`}
                    </Typography>
                  </Box>
                  <TextField
                    select
                    size="small"
                    label="Ozon 仓库"
                    value={inventory.warehouseId || ''}
                    disabled={loading || !warehouses.length}
                    onChange={(event) => updateInventory(normalizedShopId, { warehouseId: event.target.value })}
                    sx={{ flex: 1, minWidth: 220 }}
                    inputProps={{ 'aria-label': `Ozon 仓库 ${normalizedShopId}` }}
                  >
                    {warehouses.map((warehouse) => (
                      <MenuItem key={warehouseIdOf(warehouse)} value={warehouseIdOf(warehouse)}>
                        {warehouse.name || warehouseIdOf(warehouse)}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    size="small"
                    type="number"
                    label="库存数量"
                    value={inventory.stock ?? ''}
                    onChange={(event) => updateInventory(normalizedShopId, { stock: event.target.value })}
                    inputProps={{ min: 0, step: 1, inputMode: 'numeric', 'aria-label': `库存数量 ${normalizedShopId}` }}
                    sx={{ width: { xs: '100%', md: 150 } }}
                  />
                  <Button
                    size="small"
                    onClick={() => onReload?.(normalizedShopId)}
                    disabled={loading || applying}
                    startIcon={loading ? <CircularProgress size={14} /> : null}
                    sx={{ minWidth: 96 }}
                  >
                    {loading ? '读取中…' : '重新读取'}
                  </Button>
                </Stack>
              </Paper>
            );
          })}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={applying}>取消</Button>
        <Button
          variant="contained"
          onClick={apply}
          disabled={anyLoading || applying || !allWarehousesReady || enabledSkuCount === 0}
        >
          {applying ? '应用中…' : `应用到 ${selectedShopIds.length} 家店铺`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
