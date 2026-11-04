import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '../../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import React from 'react';

export function AccountRemovalSkipBackupDialog({ open, busy, onClose, onConfirm }) {
  const [acknowledged, setAcknowledged] = React.useState(false);

  React.useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  const confirm = async () => {
    if (!acknowledged || busy) return;
    await onConfirm();
    setAcknowledged(false);
  };

  return (
    <Dialog open={Boolean(open)} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>跳过备份并永久删除</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Alert severity="error">
            跳过备份后，采购补录、货源关系和跨境回查等数据可能永久无法恢复。
          </Alert>
          <FormControlLabel
            control={(
              <Checkbox
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={busy}
              />
            )}
            label="我了解跳过备份后这些数据可能无法恢复"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>返回备份</Button>
        <Button color="error" variant="contained" onClick={confirm} disabled={!acknowledged || busy}>
          仍然永久删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}
