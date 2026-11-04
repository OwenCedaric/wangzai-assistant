import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export function PromptLibraryCategoryDialog({
  open,
  onClose,
  categoryError,
  categoryDraft,
  onCategoryDraftChange,
  editingCategoryValue,
  onSaveCategory,
  onCancelEditCategory,
  categoryCounts,
  onEditCategory,
  onDeleteCategory,
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth className="prompt-library-category-dialog">
      <DialogTitle>管理工具分类</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} mt={0.5}>
          {categoryError ? (
            <Alert severity="warning" className="prompt-library-local-alert">
              {categoryError}
            </Alert>
          ) : null}
          <Box className="prompt-library-category-form">
            <TextField
              label="工具分类名称"
              value={categoryDraft}
              onChange={(event) => onCategoryDraftChange(event.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              startIcon={editingCategoryValue ? <SaveRounded /> : <AddRounded />}
              onClick={onSaveCategory}
            >
              {editingCategoryValue ? '保存分类' : '新增分类'}
            </Button>
            {editingCategoryValue ? (
              <Button variant="outlined" onClick={onCancelEditCategory}>
                取消编辑
              </Button>
            ) : null}
          </Box>
          <Box className="prompt-library-category-list">
            {categoryCounts.map((item) => (
              <Box key={item.value} className="prompt-library-category-row">
                <Box className="prompt-library-category-info">
                  <Typography variant="subtitle1" noWrap title={item.label}>
                    {item.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {item.count} 个工具
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.75}>
                  <IconButton size="small" aria-label={`编辑${item.label}`} onClick={() => onEditCategory(item)}>
                    <EditRounded fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    aria-label={`删除${item.label}`}
                    onClick={() => onDeleteCategory(item)}
                  >
                    <DeleteOutlineRounded fontSize="small" />
                  </IconButton>
                </Stack>
              </Box>
            ))}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions className="prompt-library-editor-actions">
        <Button onClick={onClose}>完成</Button>
      </DialogActions>
    </Dialog>
  );
}
