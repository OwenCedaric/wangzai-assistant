
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  formatDataBackupBytes,
  formatDataBackupCount,
  formatDataBackupTime,
  getDataBackupVerificationLabel,
} from '../lib/dataBackupPresentation.js';

function operationLabel(record = {}) {
  if (record.operationType === 'historical-order-import') return '历史订单导入';
  if (record.operationType === 'backup-import' || record.operationType === 'restore') return '软件备份恢复';
  return '备份导出';
}

function operationCount(record = {}) {
  return record.totalRecords
    || record.summary?.importedRows
    || record.summary?.validRows
    || record.summary?.totalRows
    || 0;
}

function operationStatus(record = {}) {
  if (record.operationType !== 'historical-order-import') return getDataBackupVerificationLabel(record);
  if (record.status === 'completed' || record.status === 'verified') return '导入成功';
  if (record.status === 'failed') return '导入失败';
  if (record.status === 'partial') return '部分导入';
  return '状态未知';
}

export function DataBackupHistoryPanel({ backups = [], imports = [], onResumeHistoricalImport }) {
  const records = [...backups, ...imports].sort((left, right) => (
    String(right.completedAt || '').localeCompare(String(left.completedAt || ''))
  ));
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" fontWeight={800}>备份与导入记录</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5} mb={1.5}>
          仅展示操作时间、数量和校验状态，不展示文件路径或业务明文。
        </Typography>
        {records.length ? (
          <List disablePadding aria-label="数据备份与导入记录">
            {records.map((record, index) => (
              <Stack key={`${record.operationType || 'backup'}-${record.id || index}`}>
                {index > 0 ? <Divider /> : null}
                <ListItem disableGutters sx={{ alignItems: 'flex-start', gap: 1.5 }}>
                  <ListItemText
                    primary={record.fileName || record.displayName || `${operationLabel(record)} ${index + 1}`}
                    secondary={`${operationLabel(record)} · ${formatDataBackupTime(record.completedAt)} · ${formatDataBackupCount(operationCount(record))} 条${record.operationType === 'historical-order-import' ? '' : ` · ${formatDataBackupBytes(record.logicalBytes)}${record.coverageMode === 'partial' ? ' · 部分备份' : ''}${record.packageVersion ? ` · 格式版本 ${record.packageVersion}` : ''}`}`}
                  />
                  <Stack spacing={0.75} alignItems="flex-end">
                    <Chip
                      size="small"
                      color={record.verified || record.status === 'completed' ? 'success' : 'default'}
                      variant={record.verified || record.status === 'completed' ? 'filled' : 'outlined'}
                      label={operationStatus(record)}
                    />
                    {record.operationType === 'historical-order-import'
                      && record.dimensionCandidates?.length ? (
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => onResumeHistoricalImport?.(record)}
                        >
                          继续回传尺寸
                        </Button>
                      ) : null}
                  </Stack>
                </ListItem>
              </Stack>
            ))}
          </List>
        ) : null}
      </CardContent>
    </Card>
  );
}
