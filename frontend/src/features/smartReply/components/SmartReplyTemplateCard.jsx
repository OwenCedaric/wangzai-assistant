import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function SmartReplyTemplateCard({ index, onApply, onEdit, selected, template }) {
  return (
    <Card
      variant="outlined"
      sx={{
        p: 2.25,
        borderRadius: '6px !important',
        borderColor: selected ? 'primary.main' : 'divider',
        boxShadow: selected ? '0 0 0 1px rgba(37, 99, 235, 0.14)' : 'none',
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Typography variant="subtitle2" color={selected ? 'primary.main' : 'text.primary'} fontWeight={700}>
            模板 {index + 1}
          </Typography>
          {selected ? <CheckCircleRounded color="primary" fontSize="small" /> : null}
        </Stack>

        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>
          {template.messageRu}
        </Typography>

        <Divider />

        <BoxedTranslation>{template.messageZh}</BoxedTranslation>

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button variant="text" sx={{ borderRadius: '6px !important' }} onClick={onEdit}>
            编辑模板
          </Button>
          <Button
            sx={{ borderRadius: '6px !important' }}
            variant={selected ? 'contained' : 'outlined'}
            onClick={onApply}
          >
            {selected ? '已应用此模板' : '应用此模板'}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

function BoxedTranslation({ children }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        中文译文
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>
        {children}
      </Typography>
    </Stack>
  );
}
