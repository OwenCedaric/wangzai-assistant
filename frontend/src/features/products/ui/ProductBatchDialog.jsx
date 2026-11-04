import { normalizeOzonId } from '../../../entities/order/orderShopScope.jsx';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const EMPTY_BATCH_DIALOG = { open: false, action: '', stockValue: '', warehouseId: '' };

export function ProductBatchDialog({
  open,
  batchDialog,
  activeBatchMeta,
  selectedCount = 0,
  batchSaving,
  batchWarehouseLoading,
  batchWarehouseError,
  batchWarehouseOptions = [],
  onChangeDialog,
  onClose,
  onConfirm,
}) {
  const closeIfIdle = () => {
    if (!batchSaving) onClose(EMPTY_BATCH_DIALOG);
  };

  return (
    <Dialog open={open} onClose={closeIfIdle} maxWidth="xs" fullWidth>
      <DialogTitle>{activeBatchMeta?.title || '批量操作'}</DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          color="text.secondary"
          mb={activeBatchMeta?.type === 'stock' || activeBatchMeta?.inputLabel ? 1.5 : 0}
        >
          {activeBatchMeta?.type === 'busRead'
            ? `将读取已选 ${selectedCount} 个商品的巴士实测信息，请确认后继续。`
            : `将对已选 ${selectedCount} 个商品写入 Ozon，请确认后继续。`}
        </Typography>
        {activeBatchMeta?.type === 'stock' ? (
          <TextField
            select
            fullWidth
            size="small"
            label="写入仓库"
            value={batchDialog.warehouseId}
            onChange={(event) => onChangeDialog((current) => ({ ...current, warehouseId: event.target.value }))}
            disabled={batchSaving || batchWarehouseLoading}
            helperText={
              batchWarehouseLoading
                ? '正在读取 Ozon 仓库列表'
                : batchWarehouseError || '库存会写入所选仓库，不再使用商品默认仓库'
            }
            error={Boolean(batchWarehouseError)}
            sx={{ mb: activeBatchMeta?.inputLabel ? 1.5 : 0 }}
          >
            <MenuItem value="">请选择仓库</MenuItem>
            {batchWarehouseOptions.map((warehouse) => {
              const warehouseId = normalizeOzonId(warehouse.rawId);
              return (
                <MenuItem key={warehouse.id} value={warehouseId}>
                  <Box>
                    <Typography variant="subtitle2" noWrap title={warehouse.name}>
                      {warehouse.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>
                      仓库 ID：{warehouse.rawId}
                    </Typography>
                  </Box>
                </MenuItem>
              );
            })}
          </TextField>
        ) : null}
        {activeBatchMeta?.inputLabel ? (
          <TextField
            autoFocus={activeBatchMeta?.type !== 'stock'}
            fullWidth
            size="small"
            type="number"
            label={activeBatchMeta.inputLabel}
            value={batchDialog.stockValue}
            onChange={(event) => onChangeDialog((current) => ({ ...current, stockValue: event.target.value }))}
            inputProps={{ min: 0, step: 1 }}
          />
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(EMPTY_BATCH_DIALOG)} disabled={batchSaving}>
          取消
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          disabled={
            batchSaving || (activeBatchMeta?.type === 'stock' && (batchWarehouseLoading || !batchDialog.warehouseId))
          }
        >
          {batchSaving ? '提交中' : activeBatchMeta?.confirmLabel || '确认'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
