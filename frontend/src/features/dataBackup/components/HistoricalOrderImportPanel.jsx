import CloudUploadRounded from '@mui/icons-material/CloudUploadRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import FactCheckRounded from '@mui/icons-material/FactCheckRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HISTORICAL_ORDER_IMPORT_FIELDS } from '../lib/historicalOrderImportSchema.js';
import { formatDataBackupCount } from '../lib/dataBackupPresentation.js';
import { DataBackupShopSelect } from './DataBackupShopSelect.jsx';

const PREVIEW_SUMMARY = [
  ['totalRows', '总行数'],
  ['readyRows', '可导入'],
  ['matchedRows', '已匹配'],
  ['selectionRequiredRows', '待选商品'],
  ['unmatchedRows', '未匹配'],
  ['conflictRows', '冲突'],
  ['skippedRows', '跳过'],
  ['invalidRows', '无效'],
];

function candidateLabel(candidate = {}) {
  const id = String(candidate.productId || '').trim();
  return id ? `${candidate.name || '未命名商品'}（Ozon商品ID：${id}）` : candidate.name || '未命名商品';
}

export function HistoricalOrderImportPanel({ shopOptions = [], shopId, onShopChange, model }) {
  const inputRef = React.useRef(null);
  const working = ['parsing', 'preflighting', 'confirming'].includes(model.status);
  const selectionRows = (model.preview?.rows || []).filter((row) => row.requiresSelection);
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" fontWeight={800}>历史订单导入</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              表格只要求填写 Ozon订单号；成本、货源、采购信息、长宽高和重量均为可选项。
              多商品订单在预检时选择具体商品，表格无需额外商品识别列。
            </Typography>
          </Box>

          <Alert severity="info">
            历史订单只保存在本机，不会自动回传 Ozon；空白不覆盖现有数据，填写 0 会保留。
          </Alert>
          {model.message ? <Alert severity={model.message.severity}>{model.message.text}</Alert> : null}

          <DataBackupShopSelect
            idPrefix="historical-order-import-shop"
            label="历史订单所属店铺"
            value={shopId}
            disabled={working || !shopOptions.length}
            options={shopOptions}
            onChange={onShopChange}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <input
              ref={inputRef}
              hidden
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="选择历史订单文件"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) model.selectFile(file);
              }}
            />
            <Button
              variant="outlined"
              startIcon={model.status === 'parsing'
                ? <CircularProgress size={16} color="inherit" />
                : <CloudUploadRounded />}
              disabled={working || !shopId}
              onClick={() => inputRef.current?.click()}
            >
              {model.status === 'parsing' ? '正在读取文件' : '选择 Excel/CSV 文件'}
            </Button>
            <Button
              variant="text"
              startIcon={<DownloadRounded />}
              disabled={working}
              onClick={model.downloadTemplate}
            >
              下载历史订单模板
            </Button>
          </Stack>

          {model.sheet ? (
            <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Stack spacing={1.25}>
                <Typography fontWeight={800}>{model.sheet.fileName}</Typography>
                <Typography variant="caption" color="text.secondary">
                  共读取 {formatDataBackupCount(model.sheet.rows.length)} 行。长度、宽度、高度和重量填写后必须大于 0。
                </Typography>
                <Typography variant="subtitle2" fontWeight={800}>字段对应关系</Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
                    gap: 1,
                  }}
                >
                  {model.mappings.map((mapping) => (
                    <TextField
                      key={mapping.columnIndex}
                      select
                      size="small"
                      label={`“${mapping.sourceHeader}”对应字段`}
                      value={mapping.field}
                      disabled={working}
                      onChange={(event) => model.updateMapping(mapping.columnIndex, event.target.value)}
                    >
                      <MenuItem value="">忽略此列</MenuItem>
                      {HISTORICAL_ORDER_IMPORT_FIELDS.map((definition) => (
                        <MenuItem key={definition.field} value={definition.field}>
                          {definition.group === 'identity' ? '唯一必填 · ' : '可选 · '}{definition.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  ))}
                </Box>
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  <Chip size="small" color="success" label={`可预检 ${formatDataBackupCount(model.localResult.rows.length)} 行`} />
                  <Chip size="small" label={`跳过 ${formatDataBackupCount(model.localResult.skippedRows)} 行`} />
                  <Chip
                    size="small"
                    color={model.localResult.issues.length ? 'warning' : 'default'}
                    label={`需检查 ${formatDataBackupCount(model.localResult.issues.length)} 项`}
                  />
                </Stack>
                {model.localResult.issues.length ? (
                  <Typography variant="caption" color="warning.main">
                    {model.localResult.issues.slice(0, 3).map((issue) => issue.message).join('；')}
                    {model.localResult.issues.length > 3 ? '；其余问题将在预检中汇总。' : ''}
                  </Typography>
                ) : null}
              </Stack>
            </Box>
          ) : null}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="outlined"
              startIcon={model.status === 'preflighting'
                ? <CircularProgress size={16} color="inherit" />
                : <FactCheckRounded />}
              disabled={!model.canPreflight}
              onClick={model.runPreflight}
            >
              {model.status === 'preflighting'
                ? '正在预检'
                : model.preview ? '重新预检选择' : '预检历史订单'}
            </Button>
          </Stack>

          {model.preview ? (
            <Box sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}>
              <Stack spacing={1.25}>
                <Typography fontWeight={800}>本地导入预览</Typography>
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  {PREVIEW_SUMMARY.map(([field, label]) => (
                    <Chip
                      key={field}
                      size="small"
                      color={field === 'selectionRequiredRows' && model.preview.summary?.[field]
                        ? 'warning'
                        : 'default'}
                      label={`${label} ${formatDataBackupCount(model.preview.summary?.[field])}`}
                    />
                  ))}
                </Stack>

                {selectionRows.length ? (
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" fontWeight={800}>多商品订单：选择本行对应商品</Typography>
                    {selectionRows.map((row) => (
                      <TextField
                        key={row.rowIndex}
                        select
                        size="small"
                        label={`订单 ${row.orderNumber || row.rowNumber}`}
                        value={model.productSelections[row.rowIndex]
                          || row.selectedProduct?.productIdentityId
                          || ''}
                        disabled={working}
                        helperText="选择后点击“重新预检选择”，确认无误才能导入。"
                        onChange={(event) => model.updateProductSelection(row.rowIndex, event.target.value)}
                      >
                        <MenuItem value="">请选择具体商品</MenuItem>
                        {row.productCandidates.map((candidate) => (
                          <MenuItem
                            key={candidate.productIdentityId || candidate.productId}
                            value={candidate.productIdentityId || candidate.productId}
                          >
                            {candidateLabel(candidate)}
                          </MenuItem>
                        ))}
                      </TextField>
                    ))}
                  </Stack>
                ) : null}

                <Typography variant="caption" color="text.secondary">
                  使用安全合并：空白项不会覆盖已有本地数据。本步骤不会调用任何 Ozon 写入接口。
                </Typography>
              </Stack>
            </Box>
          ) : null}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={model.status === 'confirming'
                ? <CircularProgress size={16} color="inherit" />
                : <SaveRounded />}
              disabled={!model.canConfirm}
              onClick={model.runConfirm}
            >
              {model.status === 'confirming' ? '正在保存本地' : '历史订单导入'}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
