import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React, { useEffect, useState } from 'react';
import { smartReplyVariables } from '../constants/smartReplyTemplateCatalog.js';

const MAX_TEMPLATE_LENGTH = 500;

function createDraft(template) {
  return {
    id: template?.id || '',
    messageRu: template?.messageRu || '',
    messageZh: template?.messageZh || '',
  };
}

export function SmartReplyTemplateEditorDialog({ mode, onClose, onSave, open, template }) {
  const [draft, setDraft] = useState(() => createDraft(template));

  useEffect(() => {
    if (open) setDraft(createDraft(template));
  }, [open, template]);

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const insertVariable = (placeholder) => {
    setDraft((current) => {
      const separator = current.messageRu && !current.messageRu.endsWith(' ') ? ' ' : '';
      return {
        ...current,
        messageRu: `${current.messageRu}${separator}${placeholder}`.slice(0, MAX_TEMPLATE_LENGTH),
      };
    });
  };

  const trimmedMessage = draft.messageRu.trim();
  const canSave = Boolean(trimmedMessage) && draft.messageRu.length <= MAX_TEMPLATE_LENGTH;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      slotProps={{ paper: { sx: { borderRadius: '6px !important' } } }}
    >
      <DialogTitle>{mode === 'edit' ? '编辑模板消息' : '创建模板消息'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            label="俄语模板内容"
            value={draft.messageRu}
            onChange={(event) => updateDraft('messageRu', event.target.value)}
            multiline
            minRows={8}
            inputProps={{ maxLength: MAX_TEMPLATE_LENGTH }}
            helperText={`${draft.messageRu.length} / ${MAX_TEMPLATE_LENGTH}`}
            fullWidth
            sx={{ '& .MuiOutlinedInput-root': { borderRadius: '6px !important' } }}
          />

          <Stack spacing={0.75}>
            <Typography variant="body2" color="text.secondary">
              点击变量，追加到俄语模板内容中
            </Typography>
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
              {smartReplyVariables.map((variable) => (
                <Button
                  key={variable.code}
                  variant="outlined"
                  size="small"
                  sx={{ borderRadius: '6px !important' }}
                  onClick={() => insertVariable(variable.placeholder)}
                >
                  {variable.name}
                </Button>
              ))}
            </Stack>
          </Stack>

          <TextField
            label="中文译文"
            value={draft.messageZh}
            onChange={(event) => updateDraft('messageZh', event.target.value)}
            multiline
            minRows={4}
            helperText="帮助核对俄语消息内容。"
            fullWidth
            sx={{ '& .MuiOutlinedInput-root': { borderRadius: '6px !important' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button sx={{ borderRadius: '6px !important' }} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="contained"
          sx={{ borderRadius: '6px !important' }}
          disabled={!canSave}
          onClick={() => onSave({ ...draft, messageRu: trimmedMessage })}
        >
          保存模板
        </Button>
      </DialogActions>
    </Dialog>
  );
}
