import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

export function ProductSaveConfirmDialog({
  open,
  saving,
  onClose,
  onConfirm,
  saveChangeItems,
  changedAttributeRows,
  productCardDiff,
}) {
  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="md"
      fullWidth
      className="product-save-confirm-dialog"
    >
      <DialogTitle>商品写入差异预览</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Alert severity="warning">
            确认后会先进入写入安全门；本机 local-api 写入总开关开启时会执行真实 Ozon 写入，未开启时不会写线上。
          </Alert>
          <Box className="product-save-confirm-summary">
            <Typography variant="caption" color="text.secondary">
              本次变更
            </Typography>
            <Typography variant="subtitle1">
              {saveChangeItems.length > 0 ? saveChangeItems.join('、') : '没有检测到变更'}
            </Typography>
            {changedAttributeRows.length > 0 ? (
              <Typography variant="body2" color="text.secondary">
                属性变更 {changedAttributeRows.length} 项：
                {changedAttributeRows
                  .slice(0, 4)
                  .map((item) => item.label)
                  .join('、')}
                {changedAttributeRows.length > 4 ? ' 等' : ''}
              </Typography>
            ) : null}
            {productCardDiff.changes.length > 0 ? (
              <TableContainer sx={{ mt: 1, maxHeight: 280 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>字段</TableCell>
                      <TableCell>修改前</TableCell>
                      <TableCell>修改后</TableCell>
                      <TableCell>写入范围</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {productCardDiff.changes.map((item) => (
                      <TableRow key={`${item.field}:${item.label}`}>
                        <TableCell>{item.label}</TableCell>
                        <TableCell>{item.before}</TableCell>
                        <TableCell>{item.after}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <Chip
                              size="small"
                              color={
                                item.writeStage === 'write_guard_only'
                                  ? 'primary'
                                  : item.writeStage === 'local_only'
                                    ? 'default'
                                    : 'warning'
                              }
                              variant={item.writeStage === 'write_guard_only' ? 'filled' : 'outlined'}
                              label={item.writeLabel || '未接入'}
                            />
                            <Typography variant="caption" color="text.secondary">
                              {item.policy?.endpointKey || item.policy?.note || '仅本地'}
                            </Typography>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : null}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          再检查一下
        </Button>
        <Button variant="contained" color="success" onClick={onConfirm} disabled={saving}>
          确认保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
