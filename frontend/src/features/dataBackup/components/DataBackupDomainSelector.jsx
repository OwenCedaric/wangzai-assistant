import CheckBoxRounded from '@mui/icons-material/CheckBoxRounded';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { formatDataBackupBytes, formatDataBackupCount } from '../lib/dataBackupPresentation.js';

export function DataBackupDomainSelector({
  domains = [],
  selectedDomains = [],
  disabled = false,
  onToggle,
  onSelectAll,
  onRequiredOnly,
}) {
  const selected = new Set(selectedDomains);
  const selectedCount = domains.filter((domain) => selected.has(domain.domain)).length;
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Typography fontWeight={800} sx={{ flex: 1 }}>选择备份内容</Typography>
        <Chip size="small" color="primary" label={`已选 ${selectedCount}/${domains.length} 类`} />
        <Button size="small" disabled={disabled || !domains.length} onClick={onSelectAll}>全选</Button>
        <Button size="small" disabled={disabled || !domains.length} onClick={onRequiredOnly}>仅保留必需项</Button>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 1,
          maxHeight: 300,
          overflowY: 'auto',
          pr: 0.5,
        }}
      >
        {domains.map((domain) => {
          const checked = selected.has(domain.domain);
          const required = domain.requiredForRestore === true;
          return (
            <Box
              key={domain.domain}
              sx={{
                border: '1px solid',
                borderColor: checked ? 'primary.light' : 'divider',
                bgcolor: checked ? 'primary.50' : 'background.paper',
                borderRadius: 2,
                px: 1.25,
                py: 0.75,
                minWidth: 0,
              }}
            >
              <FormControlLabel
                sx={{ m: 0, width: '100%', alignItems: 'flex-start' }}
                control={(
                  <Checkbox
                    size="small"
                    checked={checked}
                    disabled={disabled || required}
                    checkedIcon={<CheckBoxRounded />}
                    onChange={() => onToggle?.(domain.domain)}
                  />
                )}
                label={(
                  <Stack minWidth={0} pt={0.25}>
                    <Typography variant="body2" fontWeight={800} noWrap>{domain.label}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDataBackupCount(domain.recordCount)} 条 · {formatDataBackupBytes(domain.logicalBytes)}
                    </Typography>
                  </Stack>
                )}
              />
            </Box>
          );
        })}
      </Box>
    </Stack>
  );
}
