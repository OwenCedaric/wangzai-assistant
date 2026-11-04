import SearchRounded from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  formatSmartToolModelDisplayName,
  resolveSmartToolModelSelection,
  SMART_TOOL_AUTO_MODEL_ID,
} from '../../promptLibrary/services/smartToolModelService.js';
import { runProfitOrderReview } from '../services/profitOrderReviewService.js';
import { ProfitOrderReviewReport } from './ProfitOrderReviewReport.jsx';

export function ProfitOrderReviewRun({ selectedPrompt, shops = [], modelOptions = [] }) {
  const configuredModelId = selectedPrompt?.promptConfig?.defaultModelId || SMART_TOOL_AUTO_MODEL_ID;
  const [selectedModelId, setSelectedModelId] = React.useState(configuredModelId);
  const [orderNumber, setOrderNumber] = React.useState('');
  const [useSeerfar, setUseSeerfar] = React.useState(true);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState('');
  const [progress, setProgress] = React.useState(null);
  const controllerRef = React.useRef(null);
  const modelSelection = resolveSmartToolModelSelection(selectedModelId, modelOptions);

  React.useEffect(() => {
    setSelectedModelId(configuredModelId);
    setUseSeerfar(true);
    setResult(null);
    setError('');
  }, [configuredModelId, selectedPrompt?.id]);

  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const run = React.useCallback(async () => {
    const cleanOrderNumber = orderNumber.trim();
    if (!cleanOrderNumber) {
      setError('请输入订单号。');
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError('');
    setResult(null);
    setProgress({ stage: 'ledger', label: '正在读取利润账本' });
    try {
      const nextResult = await runProfitOrderReview({
        orderNumber: cleanOrderNumber,
        shops,
        tool: selectedPrompt,
        modelSelection,
        useSeerfar,
      }, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (controllerRef.current !== controller) return;
      setResult(nextResult);
    } catch (runError) {
      if (runError?.name === 'AbortError' || controllerRef.current !== controller) return;
      setError(runError instanceof Error ? runError.message : String(runError || '订单复核失败'));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setProgress(null);
      }
    }
  }, [modelSelection, orderNumber, selectedPrompt, shops, useSeerfar]);

  const selectSeerfarMode = React.useCallback((nextValue) => {
    setUseSeerfar(nextValue);
    setResult(null);
    setError('');
  }, []);

  const loading = Boolean(progress);
  return (
    <Box className="prompt-library-image-run-shell profit-order-review-run-shell">
      <Box component="aside" className="prompt-library-image-fixed-sidebar profit-order-review-sidebar">
        <Box className="prompt-library-image-sidebar-title">
          <Typography variant="subtitle1">订单复核</Typography>
          <Typography variant="body2" color="text.secondary">
            只输入订单号，系统自动读取利润账本、同商品历史和市场表现。
          </Typography>
        </Box>

        <Box className="prompt-library-image-fixed-section profit-order-review-model-section">
          <Typography variant="subtitle2">分析模型</Typography>
          <TextField
            select
            fullWidth
            size="small"
            label="文本模型"
            value={modelSelection.id}
            onChange={(event) => setSelectedModelId(event.target.value)}
          >
            {modelOptions.length ? modelOptions.map((item) => (
              <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                {formatSmartToolModelDisplayName(item.model)} · {item.statusLabel}
              </MenuItem>
            )) : <MenuItem value={SMART_TOOL_AUTO_MODEL_ID}>未读取到可用模型</MenuItem>}
          </TextField>
          {!modelSelection.ready ? (
            <Typography variant="caption" color="text.secondary">
              没有模型时仍会完成利润核算，只是不生成 AI 综合文案。
            </Typography>
          ) : null}
        </Box>

        <Box className="prompt-library-image-fixed-section profit-order-review-order-section">
          <Typography variant="subtitle2">订单信息</Typography>
          <TextField
            fullWidth
            size="small"
            autoFocus
            label="Ozon 订单号"
            value={orderNumber}
            placeholder="输入订单号"
            error={Boolean(error)}
            helperText={error || '系统会自动匹配当前账号和店铺。'}
            onChange={(event) => {
              setOrderNumber(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !loading) void run();
            }}
          />
        </Box>

        <Box className="prompt-library-image-fixed-section profit-order-review-seerfar-section">
          <Box className="profit-order-review-seerfar-copy">
            <Typography variant="subtitle2">Seerfar 数据</Typography>
            <Typography variant="caption" color="text.secondary">
              {useSeerfar ? '已开启市场分析' : '仅分析订单数据'}
            </Typography>
          </Box>
          <ButtonGroup
            fullWidth
            size="small"
            aria-label="是否使用 Seerfar 市场数据"
            className="profit-order-review-seerfar-toggle"
          >
            <Button
              variant={useSeerfar ? 'contained' : 'outlined'}
              aria-pressed={useSeerfar}
              onClick={() => selectSeerfarMode(true)}
            >
              使用
            </Button>
            <Button
              variant={!useSeerfar ? 'contained' : 'outlined'}
              aria-pressed={!useSeerfar}
              onClick={() => selectSeerfarMode(false)}
            >
              不使用
            </Button>
          </ButtonGroup>
        </Box>

        <Button
          variant="contained"
          fullWidth
          disabled={loading || !orderNumber.trim()}
          onClick={() => void run()}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <SearchRounded />}
        >
          {loading ? progress.label : '开始核算并分析'}
        </Button>

      </Box>

      <Box component="section" className="profit-order-review-workspace">
        {loading ? (
          <Stack spacing={1.5} alignItems="center" justifyContent="center" height="100%">
            <CircularProgress size={30} />
            <Typography variant="subtitle1">{progress.label}</Typography>
            <Typography variant="body2" color="text.secondary">
              {useSeerfar ? '利润核算完成后，会继续结合商品市场情况判断。' : '本次跳过市场查询，只根据订单和店内历史生成判断。'}
            </Typography>
          </Stack>
        ) : error ? (
          <Stack spacing={2} alignItems="center" justifyContent="center" height="100%">
            <Alert severity="warning" icon={false}>{error}</Alert>
            <Typography variant="body2" color="text.secondary">如果订单刚同步，请先到利润核算页刷新一次数据再重试。</Typography>
          </Stack>
        ) : result ? (
          <ProfitOrderReviewReport
            result={result}
            presentation={selectedPrompt?.promptConfig?.profitReviewPresentation}
          />
        ) : (
          <Box className="profit-order-review-placeholder">
            <Typography component="p">订单利润与商品投入评估</Typography>
            <Typography component="h2">输入订单号后生成完整复核报告</Typography>
            <Typography component="span">
              {useSeerfar
                ? '报告会依次核对订单利润、费用明细、同 SKU 历史和近 30 天市场表现，并给出继续投入或暂停投入的判断。'
                : '报告会核对订单利润、费用明细和同 SKU 历史，不会调用 Seerfar。'}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
