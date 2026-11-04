import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';

export function DesktopUiUpdateDialog({ state }) {
  const { open, checking, message, close } = state;
  return (
    <Dialog open={open} disableMinimize={checking} onClose={checking ? undefined : close}>
      <DialogTitle>软件更新</DialogTitle>
      <DialogContent>{checking ? <LinearProgress /> : null}<p>{message}</p></DialogContent>
      <DialogActions><Button disabled={checking} onClick={close}>知道了</Button></DialogActions>
    </Dialog>
  );
}
