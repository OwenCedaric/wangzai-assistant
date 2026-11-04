import FileOpenRounded from '@mui/icons-material/FileOpenRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { formatDataBackupCount, formatDataBackupTime } from '../lib/dataBackupPresentation.js';
import { DataBackupShopSelect } from './DataBackupShopSelect.jsx';

const SUMMARY_ITEMS = [
  ['totalRecords', '备份记录'],
  ['incomingRecords', '待恢复'],
  ['newRecords', '新增'],
  ['updateRecords', '可更新'],
  ['preservedRecords', '保留现有'],
  ['conflictRecords', '冲突'],
  ['skippedRecords', '跳过'],
  ['failedRecords', '失败'],
];

export function SoftwareBackupRestorePanel({ shopOptions = [], model }) {
  const working = model.status === 'preflighting' || model.status === 'committing';
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" fontWeight={800}>恢复软件备份</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              用于更换设备、重装软件或重新注册软件账号后恢复以前导出的本地备份。
            </Typography>
          </Box>

          {model.message ? <Alert severity={model.message.severity}>{model.message.text}</Alert> : null}

          <DataBackupShopSelect
            idPrefix="data-backup-restore-shop"
            label="恢复到店铺"
            value={model.targetShopId}
            disabled={working || !shopOptions.length}
            helperText={shopOptions.length
              ? 'Ozon 店铺备份将恢复到所选店铺。'
              : '可直接恢复采购、跨境巴士、推广、模型或外部服务账号；Ozon 备份需要先重新绑定店铺。'}
            options={shopOptions}
            onChange={model.selectTargetShop}
          />

          {model.legacyPassphraseRequired ? (
            <TextField
              label="旧版备份口令"
              type="password"
              size="small"
              value={model.legacyPassphrase}
              onChange={(event) => model.setLegacyPassphrase(event.target.value)}
              disabled={working}
              autoComplete="current-password"
              helperText="仅旧版加密备份需要；口令只在本次预检期间保存在内存中。"
              inputProps={{ minLength: 12 }}
            />
          ) : null}

          <Button
            variant="outlined"
            startIcon={model.status === 'preflighting'
              ? <CircularProgress size={16} color="inherit" />
              : <FileOpenRounded />}
            disabled={!model.canPreflight}
            onClick={model.runPreflight}
          >
            {model.status === 'preflighting' ? '正在预检' : '选择备份文件并预检'}
          </Button>

          {model.preview ? (
            <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Stack spacing={1}>
                <Typography fontWeight={800}>备份映射预览</Typography>
                <Typography variant="body2" color="text.secondary">
                  {model.preview.sourceOwner
                    ? `原账号：${model.preview.sourceOwner.ownerTypeLabel || '账号'} · ${model.preview.sourceOwner.displayName || model.preview.sourceOwner.ownerId}`
                    : `原店铺：${model.preview.sourceShop?.displayName || '等待识别'}`}
                  {' · '}
                  {model.preview.targetOwner
                    ? `恢复到：${model.preview.targetOwner.displayName || model.preview.targetOwner.ownerId}`
                    : `目标店铺：${model.preview.targetShop?.displayName
                      || shopOptions.find((shop) => shop.shopId === model.targetShopId)?.displayName
                      || '尚未映射'}`}
                </Typography>
                {model.preview.exportedAt ? (
                  <Typography variant="caption" color="text.secondary">
                    导出时间：{formatDataBackupTime(model.preview.exportedAt)}
                  </Typography>
                ) : null}
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  {SUMMARY_ITEMS.map(([field, label]) => (
                    <Chip
                      key={field}
                      size="small"
                      label={`${label} ${formatDataBackupCount(model.preview.summary?.[field])}`}
                    />
                  ))}
                </Stack>
                {model.preview.domains?.length ? (
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    {model.preview.domains.map((domain, index) => (
                      <Chip
                        key={`${domain.domain}-${index}`}
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={`${domain.label} ${formatDataBackupCount(domain.recordCount)}`}
                      />
                    ))}
                  </Stack>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  默认安全合并：空白和冲突项不会覆盖当前已有数据。
                </Typography>
              </Stack>
            </Box>
          ) : null}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={model.status === 'committing'
                ? <CircularProgress size={16} color="inherit" />
                : <RestoreRounded />}
              disabled={!model.canCommit}
              onClick={model.runCommit}
            >
              {model.status === 'committing' ? '正在恢复' : '二次确认并恢复'}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
