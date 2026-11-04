import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function ProductBatchPopover({ open, anchorEl, onClose, selectedCount = 0, onOpenDialog }) {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      PaperProps={{ className: 'product-batch-popover-paper' }}
    >
      <Box className="product-batch-card">
        <Typography variant="h6">批量操作</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.25}>
          已选 {selectedCount} 个商品
        </Typography>
        <Typography className="product-batch-section-title">上下架</Typography>
        <Box className="product-batch-action-grid">
          <Button variant="outlined" color="success" onClick={() => onOpenDialog('unarchive')}>
            批量上架
          </Button>
          <Button variant="outlined" color="error" onClick={() => onOpenDialog('archive')}>
            批量下架
          </Button>
        </Box>
        <Typography className="product-batch-section-title">库存</Typography>
        <Box className="product-batch-action-grid">
          <Button variant="outlined" onClick={() => onOpenDialog('stockAdd')}>
            批量加库存
          </Button>
          <Button variant="outlined" onClick={() => onOpenDialog('stockSubtract')}>
            批量减库存
          </Button>
          <Button variant="outlined" onClick={() => onOpenDialog('busRead')}>
            批量读取巴士
          </Button>
          <Button variant="outlined" onClick={() => onOpenDialog('stockSet')}>
            批量设置统一库存
          </Button>
        </Box>
        <Stack direction="row" spacing={0.75} alignItems="center" className="product-batch-warning">
          <WarningAmberRounded fontSize="small" />
          <span>写入 Ozon 前会二次确认</span>
        </Stack>
      </Box>
    </Popover>
  );
}
