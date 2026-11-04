import { normalizeProductAdvancedFilterValues } from '../../../entities/product/productAdvancedFilters.jsx';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function ProductAdvancedFilterPopover({
  open,
  anchorEl,
  onClose,
  groups = [],
  filters = {},
  onToggleValue,
  onReset,
}) {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      PaperProps={{
        sx: {
          mt: 1,
          width: 650,
          maxWidth: 'calc(100vw - 32px)',
          borderRadius: 3,
          boxShadow: '0 18px 50px rgba(42, 53, 71, 0.16)',
        },
      }}
    >
      <Box sx={{ p: 2.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} mb={2}>
          <Typography variant="h6">高级筛选</Typography>
          <Typography variant="body2" color="text.secondary">
            应用后只影响商品列表
          </Typography>
        </Stack>
        <Stack spacing={1.5}>
          {groups.map((group) => (
            <Stack
              key={group.id}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <Typography
                variant="body2"
                fontWeight={700}
                color="text.secondary"
                sx={{ width: 86, flex: '0 0 auto' }}
              >
                {group.label}
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {group.options.map((option) => {
                  const selectedValues = normalizeProductAdvancedFilterValues(filters[group.id]);
                  const selected =
                    option.value === 'all' ? selectedValues.length === 0 : selectedValues.includes(option.value);
                  return (
                    <Chip
                      key={option.value}
                      label={option.label}
                      color={selected ? 'primary' : 'default'}
                      variant={selected ? 'filled' : 'outlined'}
                      onClick={() => onToggleValue(group.id, option.value)}
                      sx={{ borderRadius: 2 }}
                    />
                  );
                })}
              </Stack>
            </Stack>
          ))}
        </Stack>
        <Stack direction="row" justifyContent="space-between" spacing={1} mt={2.5}>
          <Button variant="outlined" onClick={onReset}>
            重置
          </Button>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={onClose}>
              取消
            </Button>
            <Button variant="contained" onClick={onClose}>
              应用筛选
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Popover>
  );
}
