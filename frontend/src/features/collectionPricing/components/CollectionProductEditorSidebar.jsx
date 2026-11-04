import ImageRounded from '@mui/icons-material/ImageRounded';
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import LocalShippingOutlined from '@mui/icons-material/LocalShippingOutlined';
import PsychologyRounded from '@mui/icons-material/PsychologyRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { formatSmartToolModelDisplayName } from '../../promptLibrary/services/smartToolModelService.js';

function SectionTitle({ icon, title, subtitle }) {
  return (
    <Stack direction="row" spacing={0.8} alignItems="center">
      <Box sx={{ display: 'grid', placeItems: 'center', color: '#68758d' }}>{icon}</Box>
      <Box minWidth={0}>
        <Typography variant="subtitle2" fontWeight={850} sx={{ color: '#27334d', letterSpacing: '-0.01em' }}>{title}</Typography>
        {subtitle ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.1 }}>{subtitle}</Typography> : null}
      </Box>
    </Stack>
  );
}

function SidebarPanel({ children, sx = {} }) {
  return (
    <Box
      sx={{
        p: 1.25,
        border: '1px solid #e6eaf2',
        borderRadius: 1.25,
        bgcolor: '#fff',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.025)',
        ...sx,
      }}
    >
      <Stack spacing={1}>{children}</Stack>
    </Box>
  );
}

function ModelSelect({ label, value, options, onChange, emptyLabel }) {
  return (
    <TextField
      select
      size="small"
      fullWidth
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      sx={{ '& .MuiOutlinedInput-root': { height: 42, borderRadius: 1, bgcolor: '#fbfcff' } }}
    >
      {options.length ? options.map((item) => (
        <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
          {item.displayName || formatSmartToolModelDisplayName(item.model || item.label)}
          {item.id === 'auto' ? '（智能推荐）' : ''}
          {!item.ready ? '（不可用）' : ''}
        </MenuItem>
      )) : <MenuItem value="auto">{emptyLabel}</MenuItem>}
    </TextField>
  );
}

const SHIPPING_OPTIONS = Object.freeze([
  { value: 'free', label: '包邮' },
  { value: 'fixed', label: '固定运费' },
  { value: 'starting', label: '运费起步价' },
  { value: 'destination', label: '按地区计算' },
  { value: 'unknown', label: '待确认' },
]);

const MIXED_BATCH_OPTIONS = Object.freeze([
  { value: 'yes', label: '支持混批' },
  { value: 'no', label: '不支持混批' },
  { value: 'unknown', label: '混批待确认' },
]);

function freightSummary(draft = {}) {
  if (draft.shippingRuleText) return draft.shippingRuleText;
  if (draft.shippingStatus === 'free') return '来源页显示包邮。';
  if (draft.shippingStatus === 'starting') return `运费 ¥${draft.shippingFeeMin || '-'} 起，最终采购成本需按收货地区复核。`;
  if (draft.shippingStatus === 'fixed') return `固定运费 ¥${draft.shippingFeeMin || draft.shippingFeeMax || '-'}。`;
  if (draft.shippingStatus === 'destination') return '运费按收货地区计算，核价前必须复核实际运费。';
  return '未读取到明确运费，核价前必须确认，避免低价商品被高运费抬高成本。';
}

function optionLabel(options, value) {
  return options.find((item) => item.value === value)?.label || '待确认';
}

function ReadOnlyValue({ label, value, testId }) {
  return (
    <Box
      data-testid={testId}
      sx={{
        minWidth: 0,
        height: 54,
        boxSizing: 'border-box',
        px: 1.05,
        py: 0.7,
        overflow: 'hidden',
        bgcolor: '#f8fafe',
        border: '1px solid #e7ebf2',
        borderRadius: 0.9,
      }}
    >
      <Typography
        color="text.secondary"
        noWrap
        title={label}
        sx={{ display: 'block', fontSize: 12, lineHeight: 1.1 }}
      >
        {label}
      </Typography>
      <Typography
        fontWeight={750}
        noWrap
        title={String(value || '未提供')}
        sx={{ mt: 0.25, fontSize: 14.5, lineHeight: 1.2 }}
      >
        {value || '未提供'}
      </Typography>
    </Box>
  );
}

function ReadOnlyGrid({ children, embedded = false }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 0.65,
        overflow: 'visible',
        bgcolor: embedded ? 'transparent' : '#fff',
      }}
    >
      {children}
    </Box>
  );
}

export function CollectionProductEditorSidebar({
  product,
  draft,
  textModelOptions = [],
  imageModelOptions = [],
  imageSizeOptions = [],
  imageQualityOptions = [],
  onChange,
}) {
  const set = (field) => (event) => onChange(field, event.target.value);
  return (
    <Box
      component="aside"
      sx={{
        width: 376,
        flex: '0 0 376px',
        minHeight: 0,
        overflowY: 'auto',
        borderRight: '1px solid',
        borderColor: '#e5eaf2',
        bgcolor: '#f7f9fc',
        p: 1.5,
        scrollbarGutter: 'stable',
        '&::-webkit-scrollbar': { width: 8 },
        '&::-webkit-scrollbar-thumb': { bgcolor: '#cfd6e3', borderRadius: 8, border: '2px solid #f7f9fc' },
      }}
    >
      <Stack spacing={1.15}>
        <Box sx={{ px: 0.25, pb: 0.15 }}>
          <Typography variant="subtitle1" fontWeight={850} sx={{ color: '#24314b' }}>编辑设置</Typography>
          <Typography variant="caption" color="text.secondary">选择模型，然后编辑图片、属性和全部 SKU。</Typography>
          <Stack direction="row" spacing={0.5} mt={0.5} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={product?.platform || '来源'} sx={{ height: 24, borderRadius: 0.75, fontWeight: 750 }} />
            <Chip size="small" label={`SKU ${draft.skus.length}`} sx={{ height: 24, borderRadius: 0.75, fontWeight: 750 }} />
            <Chip size="small" label={`图片 ${draft.mainImages.length + draft.skuImages.length + draft.detailImages.length}`} sx={{ height: 24, borderRadius: 0.75, fontWeight: 750 }} />
          </Stack>
        </Box>

        <SidebarPanel>
          <SectionTitle icon={<PsychologyRounded fontSize="small" />} title="模型" />
          <ModelSelect
            label="分析 / 文案模型"
            value={draft.editorSettings.textModelId}
            options={textModelOptions}
            emptyLabel="未读取到文本模型"
            onChange={(value) => onChange('editorSettings.textModelId', value)}
          />
          <ModelSelect
            label="图片生成模型"
            value={draft.editorSettings.imageModelId}
            options={imageModelOptions}
            emptyLabel="未读取到图片模型"
            onChange={(value) => onChange('editorSettings.imageModelId', value)}
          />
          <Stack direction="row" spacing={0.75}>
            <TextField
              select size="small" fullWidth label="输出尺寸"
              value={draft.editorSettings.imageSize}
              onChange={(event) => onChange('editorSettings.imageSize', event.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { height: 42, borderRadius: 1, bgcolor: '#fbfcff' } }}
            >
              {imageSizeOptions.map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
            </TextField>
            <TextField
              select size="small" fullWidth label="生成质量"
              value={draft.editorSettings.imageQuality}
              onChange={(event) => onChange('editorSettings.imageQuality', event.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { height: 42, borderRadius: 1, bgcolor: '#fbfcff' } }}
            >
              {imageQualityOptions.map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
            </TextField>
          </Stack>
        </SidebarPanel>

        <SidebarPanel>
          <SectionTitle icon={<ImageRounded fontSize="small" />} title="商品基础信息" />
          <TextField required size="small" label="商品标题" value={draft.title} onChange={set('title')} fullWidth multiline maxRows={3} sx={{ '& .MuiOutlinedInput-root': { borderRadius: 1, bgcolor: '#fbfcff' } }} />
          <Stack direction="row" spacing={0.75}>
            <TextField size="small" label="最低采购价" value={draft.purchasePriceMin || draft.purchasePrice} onChange={set('purchasePriceMin')} fullWidth />
            <TextField size="small" label="最高采购价" value={draft.purchasePriceMax || draft.purchasePrice} onChange={set('purchasePriceMax')} fullWidth />
          </Stack>
          <Stack direction="row" spacing={0.75}>
            <TextField size="small" label="统一重量（g）" value={draft.weightG} onChange={set('weightG')} fullWidth />
            <TextField
              size="small" label="SKU 重量范围（g）" fullWidth disabled
              value={draft.weightMinG && draft.weightMaxG
                ? `${draft.weightMinG} - ${draft.weightMaxG}`
                : draft.weightMinG || draft.weightMaxG || '未提取'}
            />
          </Stack>
          <TextField
            size="small" label="来源类目" fullWidth
            value={draft.sourceCategoryPath || draft.sourceCategoryName || draft.category}
            onChange={set('sourceCategoryPath')}
          />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.65 }}>
            <TextField size="small" label="长 cm" value={draft.packageLengthCm} onChange={set('packageLengthCm')} />
            <TextField size="small" label="宽 cm" value={draft.packageWidthCm} onChange={set('packageWidthCm')} />
            <TextField size="small" label="高 cm" value={draft.packageHeightCm} onChange={set('packageHeightCm')} />
          </Box>
        </SidebarPanel>

        <SidebarPanel>
          <SectionTitle icon={<LocalShippingOutlined fontSize="small" />} title="运费与发货" />
          <Box sx={{ px: 0.25 }}>
            <Typography color="text.secondary" noWrap title={freightSummary(draft)} sx={{ fontSize: 12.5 }}>
              {freightSummary(draft)}
            </Typography>
          </Box>
          <ReadOnlyGrid embedded>
            <ReadOnlyValue label="运费规则" value={optionLabel(SHIPPING_OPTIONS, draft.shippingStatus)} testId="shipping-rule-value" />
            <ReadOnlyValue label="最低运费" value={draft.shippingFeeMin ? `¥${draft.shippingFeeMin}` : ''} testId="shipping-fee-value" />
            <ReadOnlyValue label="发货时效" value={draft.deliveryLeadTimeHours ? `${draft.deliveryLeadTimeHours} 小时` : ''} testId="delivery-hours-value" />
          </ReadOnlyGrid>
        </SidebarPanel>

        <SidebarPanel>
          <SectionTitle icon={<Inventory2Outlined fontSize="small" />} title="起批与采购限制" />
          <ReadOnlyGrid>
            <ReadOnlyValue label="起批数量" value={draft.minimumOrderQuantity} testId="minimum-order-value" />
            <ReadOnlyValue label="单位" value={draft.minimumOrderUnit} testId="minimum-order-unit-value" />
            <ReadOnlyValue label="混批" value={optionLabel(MIXED_BATCH_OPTIONS, draft.mixedBatchStatus)} testId="mixed-batch-value" />
            <ReadOnlyValue label="单 SKU 最少" value={draft.perSkuMinimumQuantity} testId="per-sku-minimum-value" />
            <ReadOnlyValue label="采购倍数" value={draft.purchaseMultiple} testId="purchase-multiple-value" />
            <ReadOnlyValue label="来源类目 ID" value={draft.sourceCategoryId} testId="source-category-id-value" />
          </ReadOnlyGrid>
        </SidebarPanel>
      </Stack>
    </Box>
  );
}
