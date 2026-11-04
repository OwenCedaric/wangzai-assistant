import Card from '@mui/material/Card';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { smartReplyVariables } from '../constants/smartReplyTemplateCatalog.js';

export function SmartReplyVariablePreview({ missingVariables, onValueChange, preview, values }) {
  return (
    <Card variant="outlined" sx={{ p: 2.5, borderRadius: '6px !important', position: 'sticky', top: 16 }}>
      <Stack spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="h6" component="h2">
            消息预览
          </Typography>
          <Typography variant="body2" color="text.secondary">
            填写订单信息，查看买家最终收到的消息。
          </Typography>
        </Stack>

        <Stack spacing={1.25}>
          {smartReplyVariables.map((variable) => (
            <TextField
              key={variable.code}
              label={variable.name}
              value={values[variable.code] || ''}
              onChange={(event) => onValueChange(variable.code, event.target.value)}
              size="small"
              fullWidth
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '6px !important' } }}
            />
          ))}
        </Stack>

        {missingVariables.length ? (
          <Typography variant="body2" color="error.main">
            请填写：{missingVariables.map((variable) => variable.name).join('、')}
          </Typography>
        ) : null}

        <Divider />

        <Stack spacing={0.75}>
          <Typography variant="subtitle2">买家最终看到的俄语消息</Typography>
          <Typography
            variant="body2"
            sx={{
              p: 1.75,
              borderRadius: '6px',
              bgcolor: 'grey.50',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.75,
              overflowWrap: 'anywhere',
            }}
          >
            {preview}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  );
}
