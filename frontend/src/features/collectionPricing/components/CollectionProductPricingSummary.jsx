import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

function formatRange(value, prefix = '', suffix = '') {
  if (!value || !Number.isFinite(value.minimum) || !Number.isFinite(value.maximum)) return '待读取';
  const display = (number) => number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return value.minimum === value.maximum
    ? `${prefix}${display(value.minimum)}${suffix}`
    : `${prefix}${display(value.minimum)}–${display(value.maximum)}${suffix}`;
}

function SummaryMetric({ label, value, note = '', control = null }) {
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, minHeight: 70, px: 1, py: 0.65, borderRadius: 1, borderColor: '#e4e9f1', bgcolor: '#fff', boxShadow: '0 1px 2px rgba(20, 35, 70, 0.025)' }}>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: 11.5 }}>{label}</Typography>
      {control || <Typography variant="body2" fontWeight={850} noWrap title={value} sx={{ lineHeight: 1.35, letterSpacing: '-0.01em' }}>{value}</Typography>}
      {note ? <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', fontSize: 10.25 }}>{note}</Typography> : null}
    </Paper>
  );
}

export function CollectionProductPricingSummary({ pricing }) {
  const summary = pricing?.summary;
  if (!summary) return null;
  const margin = formatRange(summary.marginRange, '', '%');
  const breakEven = formatRange(summary.breakEvenRange, '¥');
  const providerOptions = pricing.providers || [];
  const providerControl = (
    <TextField
      select size="small" value={pricing.logisticsDraft.providerId || ''}
      onChange={(event) => pricing.changeLogistics({ providerId: event.target.value })}
      inputProps={{ 'aria-label': '所属物流' }}
      sx={{ mt: 0.1, width: '100%', '& .MuiOutlinedInput-root': { height: 31, borderRadius: 0.8 }, '& .MuiInputBase-input': { py: 0.4, px: 0.75, fontWeight: 800, fontSize: 13.5 } }}
    >
      <MenuItem value="">自动识别</MenuItem>
      {providerOptions.map((provider) => <MenuItem key={provider.id} value={provider.id}>{provider.label}</MenuItem>)}
    </TextField>
  );
  const commissionControl = (
    <TextField
      size="small" value={pricing.pricingDraft.ozonFeePercent || ''}
      onChange={pricing.changePricingField('ozonFeePercent')}
      placeholder="自动读取"
      inputProps={{ 'aria-label': '类目扣点', inputMode: 'decimal' }}
      InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">%</Typography> }}
      sx={{ mt: 0.1, width: '100%', '& .MuiOutlinedInput-root': { height: 31, borderRadius: 0.8 }, '& .MuiInputBase-input': { py: 0.4, px: 0.75, fontWeight: 800, fontSize: 13.5 } }}
    />
  );
  const expectedProfitControl = (
    <TextField
      size="small" value={pricing.profitTargetMode === 'margin' ? '' : pricing.pricingDraft.expectedProfitCny || ''}
      onChange={pricing.changePricingField('expectedProfitCny')}
      placeholder="输入金额"
      inputProps={{ 'aria-label': '预期利润 / 单', inputMode: 'decimal' }}
      InputProps={{ startAdornment: <Typography variant="caption" color="text.secondary">¥</Typography> }}
      sx={{ mt: 0.1, width: '100%', '& .MuiOutlinedInput-root': { height: 31, borderRadius: 0.8 }, '& .MuiInputBase-input': { py: 0.4, px: 0.75, fontWeight: 800, fontSize: 13.5 } }}
    />
  );
  const targetMarginControl = (
    <TextField
      size="small" value={pricing.profitTargetMode === 'amount' ? '' : pricing.pricingDraft.targetMarginPercent || ''}
      onChange={pricing.changePricingField('targetMarginPercent')}
      placeholder="输入比例"
      inputProps={{ 'aria-label': '目标净利润率', inputMode: 'decimal' }}
      InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">%</Typography> }}
      sx={{ mt: 0.1, width: '100%', '& .MuiOutlinedInput-root': { height: 31, borderRadius: 0.8 }, '& .MuiInputBase-input': { py: 0.4, px: 0.75, fontWeight: 800, fontSize: 13.5 } }}
    />
  );
  return (
    <Box
      data-testid="collection-pricing-summary"
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(6, minmax(116px, 1fr))',
        gap: 0.7,
      }}
    >
      <SummaryMetric label="所属物流" value={summary.logisticsLabel} control={providerControl} note="按重量、尺寸和货值自动匹配" />
      <SummaryMetric
        label="类目扣点"
        value={Number.isFinite(summary.commissionPercent) ? `${summary.commissionPercent}%` : '未配置'}
        control={commissionControl}
        note={pricing.commissionState?.message || pricing.commissionState?.error || '自动读取后可手动修正'}
      />
      <SummaryMetric label="预计总成本" value={formatRange(summary.totalCostRange, '¥')} note="采购、物流、类目扣点及其它成本" />
      <SummaryMetric label="预期利润 / 单" value={formatRange(summary.profitRange, '¥')} control={expectedProfitControl} note="输入后按利润金额倒推" />
      <SummaryMetric label="目标净利润率" value={margin} control={targetMarginControl} note="输入后按成交收入倒推" />
      <SummaryMetric label="利润率 / 保本价" value={`${margin}${breakEven === '待读取' ? '' : ` / ${breakEven}`}`} note="全部按人民币计算" />
    </Box>
  );
}
