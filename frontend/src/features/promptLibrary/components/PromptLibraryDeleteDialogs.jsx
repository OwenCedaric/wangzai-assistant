import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function PromptDeleteDialog({ open, onClose, selectedPrompt, onDelete }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth className="prompt-library-delete-dialog">
      <DialogTitle>删除工具</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} mt={0.5}>
          <Alert severity="warning" className="prompt-library-local-alert">
            删除后只会从智能工具中心移除，不影响其他业务数据。
          </Alert>
          <Box className="prompt-library-delete-summary">
            <Typography variant="subtitle1">{selectedPrompt?.title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {selectedPrompt?.goal}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" color="error" startIcon={<DeleteOutlineRounded />} onClick={onDelete}>
          删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CategoryDeleteDialog({ target, promptCount, fallbackLabel, onClose, onDelete }) {
  return (
    <Dialog open={Boolean(target)} onClose={onClose} maxWidth="xs" fullWidth className="prompt-library-delete-dialog">
      <DialogTitle>删除工具分类</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} mt={0.5}>
          <Alert severity="warning" className="prompt-library-local-alert">
            {promptCount ? `该分类下的 ${promptCount} 个工具会移到《${fallbackLabel}》。` : '删除后不会影响工具内容。'}
          </Alert>
          <Box className="prompt-library-delete-summary">
            <Typography variant="subtitle1">{target?.label}</Typography>
            <Typography variant="body2" color="text.secondary">
              当前分类仅在智能工具中心内维护。
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" color="error" startIcon={<DeleteOutlineRounded />} onClick={onDelete}>
          删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function PromptLibraryDeleteDialogs({
  deletePromptOpen,
  onCloseDeletePrompt,
  selectedPrompt,
  onDeletePrompt,
  categoryDeleteTarget,
  categoryDeletePromptCount,
  categoryDeleteFallbackLabel,
  onCloseDeleteCategory,
  onDeleteCategory,
}) {
  return (
    <>
      <PromptDeleteDialog
        open={deletePromptOpen}
        onClose={onCloseDeletePrompt}
        selectedPrompt={selectedPrompt}
        onDelete={onDeletePrompt}
      />
      <CategoryDeleteDialog
        target={categoryDeleteTarget}
        promptCount={categoryDeletePromptCount}
        fallbackLabel={categoryDeleteFallbackLabel}
        onClose={onCloseDeleteCategory}
        onDelete={onDeleteCategory}
      />
    </>
  );
}
