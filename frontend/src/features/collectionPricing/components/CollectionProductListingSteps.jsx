import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import CloudUploadRounded from '@mui/icons-material/CloudUploadRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { translateProductAttributeName } from '../../../entities/product/productAttributes.jsx';
import {
  isListingAttributeValueFilled,
  splitListingAttributeDefinitions,
} from '../lib/collectionProductAttributeSchema.js';
import { collectionDictionaryLookupTerms } from '../lib/collectionAttributeCandidateScorer.js';
import {
  collectionAttributeLayoutSpan,
  groupCollectionAttributeDefinitions,
  sortCollectionAttributeDefinitions,
} from '../lib/collectionAttributeLayout.js';
import { buildCollectionActivitySalePriceChanges } from '../lib/collectionActivityPricing.js';
import { matchCollectedProductAttributes } from '../services/collectionAttributeMatchingService.js';
import {
  getCollectionSkuShopInventory,
  setCollectionSkuShopInventories,
  sharedCollectionSkuShopInventory,
} from '../lib/collectionProductShopInventory.js';
import { formatCollectionShopLabel, getCollectionShopId, getCollectionShopName } from '../lib/collectionShopLabel.js';
import { CollectionProductCategoryPickerDialog } from './CollectionProductCategoryPickerDialog.jsx';
import { CollectionProductBatchStockDialog } from './CollectionProductBatchStockDialog.jsx';
import { ListingTaskStatusCard } from './ListingTaskStatusCard.jsx';
import { CollectionProductPricingSummary } from './CollectionProductPricingSummary.jsx';

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: 1, bgcolor: '#fff' },
  '& .MuiInputLabel-root': { color: '#69758d' },
};
const compactPackageFieldSx = {
  width: 116,
  '& .MuiOutlinedInput-root': { height: 38, borderRadius: 1, bgcolor: '#fff' },
  '& .MuiInputBase-input': { py: 0.6, px: 1.1, fontSize: 14, fontWeight: 700 },
  '& .MuiInputLabel-root': { fontSize: 12.5 },
};
const compactAttributeFieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: 1, minHeight: 40, bgcolor: '#fff' },
  '& .MuiInputBase-input': { py: '8px' },
  '& .MuiAutocomplete-inputRoot': { py: '1px !important', pr: '34px !important' },
  '& .MuiAutocomplete-tag': {
    maxWidth: 122,
    height: 24,
    mx: '2px',
    my: '2px',
    fontSize: 12,
    borderRadius: 0.75,
  },
};

function listingAttributeDisplayValue(value = {}) {
  const rows = Array.isArray(value.values) && value.values.length
    ? value.values
    : [value.value];
  return rows.map((item) => String(item || '').trim()).filter(Boolean).join('、');
}

function collectionSkuColorDefinition(definitions = []) {
  const rows = (Array.isArray(definitions) ? definitions : []).map((definition) => ({
    definition,
    label: translateProductAttributeName(definition.name, definition.id),
  }));
  return rows.find((item) => item.label === '商品颜色')?.definition
    || rows.find((item) => /(?:商品颜色|颜色|цвет|colou?r)/iu.test(item.label))?.definition
    || null;
}

function cloneListingAttributeValue(value = {}) {
  return {
    ...value,
    values: Array.isArray(value.values) ? [...value.values] : [],
    dictionaryValueIds: Array.isArray(value.dictionaryValueIds) ? [...value.dictionaryValueIds] : [],
    evidence: Array.isArray(value.evidence) ? [...value.evidence] : value.evidence,
  };
}

function collectionSkuAttributeSummary(sku = {}, definitions = []) {
  return (Array.isArray(definitions) ? definitions : [])
    .map((definition) => listingAttributeDisplayValue(sku.attributeValues?.[String(definition.id)]))
    .filter(Boolean)
    .join(' / ');
}

function collectionSkuColorToken(sku = {}, definition = {}) {
  const terms = collectionDictionaryLookupTerms({ value: sku.sourceSkuName || '' }, definition);
  return terms.find((item) => /^[a-z][a-z\s-]*$/iu.test(String(item || '').trim()))?.toLocaleLowerCase() || '';
}

function fillReusableCollectionSkuAttributes(skus = [], specificationDefinitions = [], colorDefinition = null) {
  let nextSkus = Array.isArray(skus) ? skus : [];
  specificationDefinitions.forEach((definition) => {
    const id = String(definition.id);
    const filled = nextSkus
      .filter((sku) => sku.enabled !== false && isListingAttributeValueFilled(sku.attributeValues?.[id]))
      .map((sku) => sku.attributeValues[id]);
    const unique = new Map(filled.map((value) => [JSON.stringify(value), value]));
    if (unique.size !== 1) return;
    const template = cloneListingAttributeValue([...unique.values()][0]);
    nextSkus = nextSkus.map((sku) => (
      sku.enabled === false || isListingAttributeValueFilled(sku.attributeValues?.[id])
        ? sku
        : { ...sku, attributeValues: { ...(sku.attributeValues || {}), [id]: cloneListingAttributeValue(template) } }
    ));
  });
  if (!colorDefinition) return nextSkus;
  const colorId = String(colorDefinition.id);
  const valuesByToken = new Map();
  nextSkus.forEach((sku) => {
    const token = collectionSkuColorToken(sku, colorDefinition);
    const value = sku.attributeValues?.[colorId];
    if (!token || !isListingAttributeValueFilled(value)) return;
    const group = valuesByToken.get(token) || new Map();
    group.set(JSON.stringify(value), value);
    valuesByToken.set(token, group);
  });
  return nextSkus.map((sku) => {
    if (sku.enabled === false || isListingAttributeValueFilled(sku.attributeValues?.[colorId])) return sku;
    const group = valuesByToken.get(collectionSkuColorToken(sku, colorDefinition));
    if (group?.size !== 1) return sku;
    return {
      ...sku,
      attributeValues: {
        ...(sku.attributeValues || {}),
        [colorId]: cloneListingAttributeValue([...group.values()][0]),
      },
    };
  });
}

function countFilledCollectionSkuAttributes(skus = [], definitions = []) {
  return skus
    .filter((sku) => sku.enabled !== false)
    .reduce((total, sku) => total + definitions.filter(
      (definition) => isListingAttributeValueFilled(sku.attributeValues?.[String(definition.id)]),
    ).length, 0);
}

function shopLabel(shop = {}) {
  return formatCollectionShopLabel(shop);
}

export function CollectionProductCategoryStep({
  draft,
  options = [],
  state,
  categoryTemplateState,
  onChange,
  onSelect,
  onPreviewCategoryTemplate,
  compact = false,
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const hasConfirmedCategory = draft.categorySelectionSource === 'manual'
    && Boolean(draft.typeId && draft.descriptionCategoryId);
  const selected = hasConfirmedCategory
    ? (options.find((item) => (
        String(item.typeId) === String(draft.typeId)
        && String(item.descriptionCategoryId) === String(draft.descriptionCategoryId)
      )) || {
        typeId: draft.typeId,
        descriptionCategoryId: draft.descriptionCategoryId,
        name: draft.categoryName,
        pathText: draft.categoryPath,
      })
    : null;
  return (
    <Stack spacing={compact ? 1.25 : 2} sx={{ p: compact ? 0 : 2.25, maxWidth: compact ? 'none' : 1080 }}>
      {!compact ? <Box>
        <Typography variant="h6" fontWeight={850}>确认 Ozon 类目</Typography>
        <Typography variant="body2" color="text.secondary">系统会按来源标题和 1688 类目推荐，最终以你选择的 Ozon 类目为准。</Typography>
      </Box> : null}
      {state?.error ? <Alert severity="error">{state.error}</Alert> : null}
      <Paper
        data-testid="collection-category-confirmation-card"
        variant="outlined"
        sx={{
          p: compact ? 1.35 : 2,
          borderRadius: 1.25,
          borderColor: selected ? '#cdd9ff' : '#e1e6ef',
          bgcolor: selected ? '#f7f9ff' : '#fff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.02)',
        }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 1.25 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={750}>
                {selected ? '已通过完整类目库确认' : '尚未选择正式 Ozon 类目'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                类目只能从完整类目库确认；一键分析不会替你切换类目。
              </Typography>
            </Box>
            <Button
              variant={selected ? 'outlined' : 'contained'}
              size="small"
              disabled={state?.status === 'loading'}
              onClick={() => setPickerOpen(true)}
              sx={{ minWidth: 150, height: 40, whiteSpace: 'nowrap', boxShadow: 'none', borderRadius: 1, fontWeight: 750 }}
            >
              {state?.status === 'loading' ? '类目库读取中…' : selected ? '更换完整类目' : '完整类目库'}
            </Button>
          </Stack>
          {selected ? (
            <Box sx={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 1, p: compact ? 1 : 1.25, bgcolor: '#fff', border: '1px solid #e1e6f0', borderRadius: 1 }}>
              <Typography variant="body2" fontWeight={800} sx={{ color: '#27334d' }}>{selected.pathText || selected.name}</Typography>
              <Typography variant="caption" color="text.secondary">类目 {selected.descriptionCategoryId}</Typography>
              <Typography variant="caption" color="text.secondary">类型 {selected.typeId}</Typography>
            </Box>
          ) : null}
        </Box>
      </Paper>
      <CollectionProductCategoryPickerDialog
        open={pickerOpen}
        options={options}
        value={selected}
        templateState={categoryTemplateState}
        onPreview={onPreviewCategoryTemplate}
        onClose={() => setPickerOpen(false)}
        onConfirm={(option) => {
          onSelect(option);
          setPickerOpen(false);
        }}
      />
    </Stack>
  );
}

export function AttributeInput({ definition, value = {}, options = [], onChange, onSearch, compact = false }) {
  const searchTimerRef = React.useRef(null);
  React.useEffect(() => () => {
    if (searchTimerRef.current) globalThis.clearTimeout(searchTimerRef.current);
  }, []);
  const label = `${translateProductAttributeName(definition.name, definition.id)}${definition.is_required ? ' *' : ''}`;
  if (definition.isDictionary) {
    const resolvedOptions = [...options];
    const knownIds = new Set(resolvedOptions.map((item) => String(item?.id || '')));
    const selectedIds = definition.isCollection
      ? (value.dictionaryValueIds || []).map(String)
      : [String(value.dictionaryValueId || '')].filter(Boolean);
    const selectedLabels = definition.isCollection
      ? (Array.isArray(value.values) ? value.values : [])
      : [value.value];
    selectedIds.forEach((id, index) => {
      if (!id || knownIds.has(id)) return;
      const optionLabel = String(selectedLabels[index] || value.value || '').trim();
      if (!optionLabel) return;
      resolvedOptions.push({ id, value: optionLabel, label: optionLabel });
      knownIds.add(id);
    });
    const selected = definition.isCollection
      ? resolvedOptions.filter((item) => selectedIds.includes(String(item.id)))
      : resolvedOptions.find((item) => String(item.id) === String(value.dictionaryValueId || '')) || null;
    return (
      <Autocomplete
        size="small"
        multiple={Boolean(definition.isCollection)}
        limitTags={compact && definition.isCollection ? 2 : undefined}
        getLimitTagsText={(more) => `+${more}`}
        options={resolvedOptions}
        value={selected}
        disableCloseOnSelect={Boolean(definition.isCollection)}
        getOptionLabel={(item) => item?.label || item?.value || ''}
        isOptionEqualToValue={(left, right) => String(left?.id) === String(right?.id)}
        noOptionsText="输入关键词后查询 Ozon 标准选项"
        onOpen={() => {
          if (!options.length && onSearch) onSearch('');
        }}
        onInputChange={(_event, nextValue, reason) => {
          if (reason !== 'input' || !onSearch) return;
          if (searchTimerRef.current) globalThis.clearTimeout(searchTimerRef.current);
          const query = String(nextValue || '').trim();
          if (!query) return;
          searchTimerRef.current = globalThis.setTimeout(() => onSearch(query), 350);
        }}
        onChange={(_event, nextValue) => {
          if (definition.isCollection) {
            const rows = Array.isArray(nextValue) ? nextValue : [];
            onChange({
              value: rows.map((item) => item.value || item.label || '').join(', '),
              values: rows.map((item) => item.value || item.label || ''),
              dictionaryValueId: '',
              dictionaryValueIds: rows.map((item) => String(item.id)),
            });
            return;
          }
          onChange({
            dictionaryValueId: nextValue?.id ? String(nextValue.id) : '',
            value: nextValue?.value || nextValue?.label || '',
            values: [],
            dictionaryValueIds: [],
          });
        }}
        renderTags={(tagValue, getTagProps) => tagValue.map((option, index) => {
          const { key, ...chipProps } = getTagProps({ index });
          const optionText = option?.label || option?.value || '';
          return (
            <Chip
              key={key || `${option?.id || optionText}-${index}`}
              {...chipProps}
              size="small"
              label={optionText}
              title={optionText}
            />
          );
        })}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            label={label}
            placeholder={compact ? '搜索 Ozon 标准值' : undefined}
            helperText={compact ? undefined : '输入关键词后选择 Ozon 标准值'}
            sx={compact ? compactAttributeFieldSx : fieldSx}
          />
        )}
      />
    );
  }
  return (
    <TextField
      size="small" fullWidth label={label} value={value?.value || ''}
      onChange={(event) => onChange({ value: event.target.value, dictionaryValueId: '', values: [], dictionaryValueIds: [] })}
      helperText={compact ? undefined : (definition.isCollection ? '可以填写多个值，用逗号分隔' : '按商品实际资料填写')}
      inputProps={{ title: value?.value || definition.name || '' }}
      sx={compact ? compactAttributeFieldSx : fieldSx}
    />
  );
}

export function CollectionProductDetailsStep({ draft, definitions = [], optionsByAttributeId = {}, state, onChange, onChangeAttribute, onSearchAttributeOptions, onReload, compact = false }) {
  const [showEmptyOptional, setShowEmptyOptional] = React.useState(false);
  const globalDefinitions = React.useMemo(() => splitListingAttributeDefinitions(definitions).global, [definitions]);
  const sortedDefinitions = React.useMemo(
    () => sortCollectionAttributeDefinitions(globalDefinitions),
    [globalDefinitions],
  );
  const emptyOptionalCount = sortedDefinitions.filter((item) => (
    !item.is_required
    && !isListingAttributeValueFilled(draft.attributeValues?.[String(item.id)])
  )).length;
  const visibleDefinitions = showEmptyOptional
    ? sortedDefinitions
    : sortedDefinitions.filter((item) => (
        item.is_required
        || isListingAttributeValueFilled(draft.attributeValues?.[String(item.id)])
      ));
  const groups = React.useMemo(
    () => groupCollectionAttributeDefinitions(visibleDefinitions),
    [visibleDefinitions],
  );
  const requiredCount = sortedDefinitions.filter((item) => item.is_required).length;
  const filledCount = sortedDefinitions.filter((item) => isListingAttributeValueFilled(draft.attributeValues?.[String(item.id)])).length;
  return (
    <Stack spacing={compact ? 1.35 : 1.75} sx={{ p: compact ? 0 : 2.25, height: compact ? 'auto' : '100%', overflowY: compact ? 'visible' : 'auto' }}>
      {!compact ? <Box>
        <Typography variant="h6" fontWeight={850}>填写 Ozon 标题和类目属性</Typography>
        <Typography variant="body2" color="text.secondary">必填项排在前面；这里保存的是 Ozon 上架资料，不覆盖来源商品信息。</Typography>
      </Box> : null}
      {state?.error ? <Alert severity="error" action={onReload ? <Button size="small" onClick={onReload}>重新读取</Button> : null}>{state.error}</Alert> : null}
      {state?.warning ? <Alert severity="warning" action={onReload ? <Button size="small" onClick={onReload}>重新读取</Button> : null}>{state.warning}</Alert> : null}
      <Paper
        data-testid="collection-product-copy-card"
        variant="outlined"
        sx={{ p: compact ? 1.35 : 1.75, borderRadius: 1.25, borderColor: '#e3e8f1', bgcolor: '#fff', boxShadow: '0 1px 2px rgba(15, 23, 42, 0.025)' }}
      >
        <Typography variant="subtitle2" fontWeight={850} sx={{ mb: 1, color: '#27334d' }}>商品文案</Typography>
        <Stack spacing={1}>
          <TextField size="small" fullWidth required label="Ozon 商品标题" value={draft.title} onChange={(event) => onChange({ title: event.target.value })} sx={fieldSx} />
          <TextField size="small" fullWidth multiline minRows={compact ? 2 : 3} maxRows={6} label="商品描述" value={draft.description} onChange={(event) => onChange({ description: event.target.value })} sx={fieldSx} />
        </Stack>
      </Paper>
      <Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={0.75} mb={1}>
          <Box>
            <Typography variant="subtitle1" fontWeight={850} sx={{ color: '#27334d' }}>类目属性</Typography>
            {sortedDefinitions.length ? <Typography variant="caption" color="text.secondary">必填 {requiredCount} 项 · 已填写 {filledCount} 项{state?.mappedCount ? ` · 已从来源资料带入 ${state.mappedCount} 项` : ''}</Typography> : null}
          </Box>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            {emptyOptionalCount ? (
              <Button size="small" variant="text" onClick={() => setShowEmptyOptional((current) => !current)}>
                {showEmptyOptional ? '收起空白可选属性' : `更多可选属性（${emptyOptionalCount}）`}
              </Button>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              {state?.status === 'loading' ? '正在读取…' : `${sortedDefinitions.length} 项`}
            </Typography>
          </Stack>
        </Stack>
        {sortedDefinitions.length ? (
          <Stack spacing={0.85}>
            {groups.map((group) => {
              const halfWidthItems = group.items.filter((item) => collectionAttributeLayoutSpan(item) !== 'wide');
              const trailingFullWidthId = halfWidthItems.length % 2
                ? String(halfWidthItems.at(-1)?.id || '')
                : '';
              return (
                <Paper
                  key={group.id}
                  data-testid={`attribute-group-${group.id}`}
                  variant="outlined"
                  sx={{
                    p: 1.35,
                    borderRadius: 1.25,
                    borderColor: '#e3e8f1',
                    bgcolor: '#fff',
                    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.025)',
                  }}
                >
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  minHeight={34}
                  mb={1}
                  pb={0.75}
                  sx={{ borderBottom: '1px solid', borderColor: '#edf0f4' }}
                >
                  <Typography variant="body2" fontWeight={850} sx={{ color: '#27334d' }}>{group.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {group.items.filter((item) => item.is_required).length} 项必填 · 共 {group.items.length} 项
                  </Typography>
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, columnGap: 1.25, rowGap: 1 }}>
                  {group.items.map((definition) => {
                    const span = collectionAttributeLayoutSpan(definition);
                    const fullWidth = span === 'wide' || String(definition.id) === trailingFullWidthId;
                    return (
                      <Box
                        key={definition.id}
                        data-layout-span={span}
                        data-layout-width={fullWidth ? 'full' : 'half'}
                        sx={{
                          minWidth: 0,
                          gridColumn: { xs: '1', md: fullWidth ? '1 / -1' : 'auto' },
                        }}
                      >
                        <AttributeInput
                          compact
                          definition={definition}
                          value={draft.attributeValues?.[String(definition.id)]}
                          options={optionsByAttributeId[String(definition.id)] || []}
                          onChange={(value) => onChangeAttribute(definition.id, value)}
                          onSearch={(query) => onSearchAttributeOptions?.(definition.id, query)}
                        />
                      </Box>
                    );
                  })}
                </Box>
              </Paper>
              );
            })}
          </Stack>
        ) : (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 0.75 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography variant="body2" color="text.secondary">{state?.status === 'loading' ? '正在从 Ozon 读取这个类目需要填写的字段…' : '这个类目的字段还没有读取成功。'}</Typography>
              {state?.status !== 'loading' && onReload ? <Button size="small" variant="outlined" onClick={onReload}>重新读取类目字段</Button> : null}
            </Stack>
          </Paper>
        )}
      </Box>
    </Stack>
  );
}

export function CollectionProductSetupStep({
  draft,
  categoryOptions = [],
  categoryState,
  categoryTemplateState,
  definitions = [],
  optionsByAttributeId = {},
  attributeState,
  attributeAutofillState,
  onChange,
  onSelectCategory,
  onPreviewCategoryTemplate,
  onChangeAttribute,
  onSearchAttributeOptions,
  onReloadAttributes,
  onAnalyzeAndFill,
}) {
  const isAnalyzing = attributeAutofillState?.status === 'running';
  const canAnalyze = Boolean(
    draft.categorySelectionSource === 'manual'
    && draft.descriptionCategoryId
    && draft.typeId
    && definitions.length
    && attributeState?.status !== 'loading'
  );
  return (
    <Stack
      spacing={1.5}
      data-testid="collection-product-setup-workspace"
      sx={{
        p: { xs: 1.5, md: 2 },
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        bgcolor: '#f6f8fc',
        scrollbarGutter: 'stable',
        '&::-webkit-scrollbar': { width: 8 },
        '&::-webkit-scrollbar-thumb': { bgcolor: '#cfd6e3', borderRadius: 8, border: '2px solid #f6f8fc' },
      }}
    >
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'center' }} justifyContent="space-between" spacing={1.5}>
        <Box>
          <Typography variant="h6" fontWeight={850} sx={{ color: '#1f2a44', letterSpacing: '-0.01em' }}>类目与商品信息</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.2 }}>确认 Ozon 类目后，直接填写标题、描述及必填属性；上传店铺在 SKU/价格步骤统一选择。</Typography>
        </Box>
        <Button
          size="medium"
          variant="contained"
          disabled={!canAnalyze || isAnalyzing}
          onClick={onAnalyzeAndFill}
          sx={{ borderRadius: 1, minWidth: 160, height: 42, px: 2.25, fontWeight: 800, boxShadow: '0 6px 16px rgba(91, 130, 255, 0.2)', alignSelf: { xs: 'flex-start', md: 'center' } }}
        >
          {isAnalyzing ? <><CircularProgress size={15} color="inherit" sx={{ mr: 0.75 }} />正在分析…</> : '一键分析并填充'}
        </Button>
      </Stack>
      {attributeAutofillState?.error ? <Alert severity="error">{attributeAutofillState.error}</Alert> : null}
      {attributeAutofillState?.message ? (
        <Alert severity={attributeAutofillState.status === 'success' ? 'success' : 'info'}>
          {attributeAutofillState.message}
        </Alert>
      ) : null}
      {attributeAutofillState?.warning ? (
        <Alert severity="warning">{attributeAutofillState.warning}</Alert>
      ) : null}
      <CollectionProductCategoryStep
        compact draft={draft} options={categoryOptions} state={categoryState}
        categoryTemplateState={categoryTemplateState}
        onChange={onChange} onSelect={onSelectCategory} onPreviewCategoryTemplate={onPreviewCategoryTemplate}
      />
      <Box>
        <CollectionProductDetailsStep
          compact draft={draft} definitions={definitions} optionsByAttributeId={optionsByAttributeId}
          state={attributeState} onChange={onChange} onChangeAttribute={onChangeAttribute}
          onSearchAttributeOptions={onSearchAttributeOptions} onReload={onReloadAttributes}
        />
      </Box>
    </Stack>
  );
}

function CollectionProductSkuAttributeWorkspace({
  draft,
  definitions = [],
  optionsByAttributeId = {},
  onChangeSkuAttribute,
  onSearchAttributeOptions,
}) {
  const [activeSkuIndex, setActiveSkuIndex] = React.useState(0);
  React.useEffect(() => {
    if (activeSkuIndex >= draft.skus.length) setActiveSkuIndex(Math.max(0, draft.skus.length - 1));
  }, [activeSkuIndex, draft.skus.length]);
  const sku = draft.skus[activeSkuIndex];
  if (!definitions.length || !sku) return null;
  const requiredCount = definitions.filter((item) => item.is_required).length;
  const filledCount = definitions.filter((item) => isListingAttributeValueFilled(sku.attributeValues?.[String(item.id)])).length;
  return (
    <Paper
      variant="outlined"
      data-testid="collection-sku-attribute-workspace"
      data-layout-position="bottom"
      sx={{ m: 1.5, mt: 'auto', p: 1.5, borderRadius: 0.75, borderColor: '#dfe4ea' }}
    >
      <Stack direction={{ xs: 'column', lg: 'row' }} alignItems={{ lg: 'center' }} justifyContent="space-between" spacing={1} mb={1.25}>
        <Box>
          <Typography variant="subtitle1" fontWeight={800}>每个 SKU 的规格属性</Typography>
          <Typography variant="caption" color="text.secondary">Ozon 要求这些字段按 SKU 分别填写；当前已填写 {filledCount} / {definitions.length}，必填 {requiredCount} 项。</Typography>
        </Box>
        <TextField
          select size="small" label="正在编辑的 SKU" value={activeSkuIndex}
          onChange={(event) => setActiveSkuIndex(Number(event.target.value))}
          sx={{ ...fieldSx, width: { xs: '100%', lg: 320 } }}
        >
          {draft.skus.map((item, index) => (
            <MenuItem key={`${item.sourceSkuId}-${index}`} value={index}>
              {index + 1}. {item.sourceSkuName || item.offerId}{item.enabled === false ? '（未启用）' : ''}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 1.15 }}>
        {definitions.map((definition) => (
          <AttributeInput
            key={`${activeSkuIndex}-${definition.id}`}
            definition={definition}
            value={sku.attributeValues?.[String(definition.id)]}
            options={optionsByAttributeId[String(definition.id)] || []}
            onChange={(value) => onChangeSkuAttribute(activeSkuIndex, definition.id, value)}
            onSearch={(query) => onSearchAttributeOptions?.(definition.id, query)}
          />
        ))}
      </Box>
    </Paper>
  );
}

export function CollectionProductSkuPriceStep({
  product = {},
  draft,
  shops = [],
  selectedShopIds = [],
  warehousesByShopId = {},
  warehouseStatesByShopId = {},
  definitions = [],
  optionsByAttributeId = {},
  onChange,
  onChangeSku,
  onChangeSkuAttribute,
  onSearchAttributeOptions,
  onReloadWarehouses,
  onApplyBatchStock,
  onChangeSelectedShops,
  pricing,
}) {
  const [batchStockOpen, setBatchStockOpen] = React.useState(false);
  const [attributeBatchState, setAttributeBatchState] = React.useState({ status: 'idle', message: '', error: '' });
  const enabledCount = draft.skus.filter((item) => item.enabled !== false).length;
  const { sku: skuDefinitions } = React.useMemo(() => splitListingAttributeDefinitions(definitions), [definitions]);
  const colorDefinition = React.useMemo(() => collectionSkuColorDefinition(skuDefinitions), [skuDefinitions]);
  const specificationDefinitions = React.useMemo(() => skuDefinitions.filter(
    (definition) => String(definition.id) !== String(colorDefinition?.id || ''),
  ), [colorDefinition, skuDefinitions]);
  const defaultInventoryByShopId = React.useMemo(() => Object.fromEntries(
    selectedShopIds.map((shopId) => [shopId, sharedCollectionSkuShopInventory(draft.skus, shopId)]),
  ), [draft.skus, selectedShopIds]);
  const selectedShopRows = React.useMemo(() => {
    const shopById = new Map(shops.map((shop) => [getCollectionShopId(shop), shop]));
    return selectedShopIds.map((shopId, index) => {
      const normalizedShopId = String(shopId || '').trim();
      const shop = shopById.get(normalizedShopId) || {};
      return {
        shopId: normalizedShopId,
        name: getCollectionShopName(shop) || `店铺 ${index + 1}`,
        label: formatCollectionShopLabel(shop, normalizedShopId),
        warehouses: warehousesByShopId[normalizedShopId] || [],
      };
    }).filter((item) => item.shopId);
  }, [selectedShopIds, shops, warehousesByShopId]);
  const changeShopInventory = (sku, index, shopId, changes) => {
    const currentInventory = getCollectionSkuShopInventory(sku, shopId);
    const nextInventory = { ...currentInventory, ...changes };
    onChangeSku(index, {
      inventoryByShopId: setCollectionSkuShopInventories(sku, {
        [shopId]: nextInventory,
      }),
    });
  };
  const openBatchStock = () => {
    setBatchStockOpen(true);
  };
  const fillSkuAttributes = async () => {
    if (!enabledCount || !skuDefinitions.length || attributeBatchState.status === 'pending') return;
    const totalCount = enabledCount * skuDefinitions.length;
    const reusableSkus = fillReusableCollectionSkuAttributes(
      draft.skus,
      specificationDefinitions,
      colorDefinition,
    );
    const reusableFilledCount = countFilledCollectionSkuAttributes(reusableSkus, skuDefinitions);
    if (reusableFilledCount === totalCount) {
      if (reusableSkus.some((sku, index) => sku !== draft.skus[index])) onChange({ skus: reusableSkus });
      setAttributeBatchState({ status: 'success', message: `已填 ${reusableFilledCount}/${totalCount} 项`, error: '' });
      return;
    }
    setAttributeBatchState({ status: 'pending', message: '正在匹配全部 SKU…', error: '' });
    try {
      const enabledSkus = reusableSkus.filter((item) => item.enabled !== false);
      const productSkus = Array.isArray(product.skus) ? product.skus : [];
      const sourceProduct = {
        ...product,
        title: product.title || draft.title,
        skus: enabledSkus.map((sku, index) => {
          const sourceSku = productSkus.find((item) => String(item?.id ?? item?.skuId ?? '') === String(sku.sourceSkuId || ''))
            || productSkus[index]
            || {};
          return {
          ...sourceSku,
          id: String(sku.sourceSkuId || `sku-${index + 1}`),
          name: sourceSku.name || sku.sourceSkuName || sku.offerId || `规格 ${index + 1}`,
          attributes: [
            ...(Array.isArray(sourceSku.attributes) ? sourceSku.attributes : []),
            ...(Array.isArray(sku.sourceAttributes) ? sku.sourceAttributes : []),
            ...(colorDefinition && sku.sourceSkuName
              ? [{ name: '颜色', value: sku.sourceSkuName }]
              : []),
          ],
        };
        }),
      };
      const matched = await matchCollectedProductAttributes({
        product: sourceProduct,
        draft: { ...draft, skus: enabledSkus },
        definitions: skuDefinitions,
        optionsByAttributeId,
        searchAttributeOptions: onSearchAttributeOptions,
        dictionaryConcurrency: 4,
      });
      const mappedBySourceSkuId = new Map(matched.skus.map((item) => [String(item.sourceSkuId || ''), item]));
      let nextSkus = reusableSkus.map((sku) => {
        if (sku.enabled === false) return sku;
        const mapped = mappedBySourceSkuId.get(String(sku.sourceSkuId || ''));
        return mapped ? { ...sku, attributeValues: mapped.attributeValues } : sku;
      });
      nextSkus = fillReusableCollectionSkuAttributes(nextSkus, specificationDefinitions, colorDefinition);
      const filledCount = countFilledCollectionSkuAttributes(nextSkus, skuDefinitions);
      onChange({ skus: nextSkus });
      setAttributeBatchState({
        status: 'success',
        message: `已填 ${filledCount}/${totalCount} 项${filledCount < totalCount ? '，其余请人工确认' : ''}`,
        error: '',
      });
    } catch (error) {
      setAttributeBatchState({
        status: 'error', message: '',
        error: error instanceof Error ? error.message : 'SKU 属性批量填充失败。',
      });
    }
  };
  const activityPriceUpload = pricing?.activityPriceUpload === true || draft.activityPriceUpload === true;
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 1.5, py: 1.15, borderBottom: '1px solid', borderColor: '#e8ecf3', bgcolor: '#fcfdff' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(330px, 0.7fr) minmax(780px, 2.3fr)',
            alignItems: 'stretch',
            gap: 1.1,
            mb: 0.9,
          }}
        >
          <Box sx={{ alignSelf: 'center', minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={850} sx={{ lineHeight: 1.25, letterSpacing: '-0.01em' }}>设置 SKU 和人民币销售价</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15 }}>
              已启用 {enabledCount} / {draft.skus.length} 个 SKU · {activityPriceUpload ? '活动原价 2 倍，成交价保持核算价' : '人民币直接上架'}
            </Typography>
            <Stack direction="row" spacing={0.65} sx={{ mt: 0.7 }}>
              <Button
                size="small"
                variant="contained"
                disabled={!pricing?.canGenerateSkuPrices || pricing?.applyState?.status === 'pending'}
                onClick={pricing?.applySuggestedPrice}
                sx={{ minWidth: 156, height: 34, borderRadius: 1, fontWeight: 750, boxShadow: 'none' }}
              >
                {pricing?.applyState?.status === 'pending' ? '逐 SKU 核价中…' : '按 SKU 生成售价'}
              </Button>
              <Button
                size="small"
                variant="outlined"
                aria-pressed={activityPriceUpload}
                disabled={pricing?.applyState?.status === 'pending'}
                onClick={pricing?.toggleActivityPriceUpload}
                sx={{
                  minWidth: 128,
                  height: 34,
                  borderRadius: 1,
                  fontWeight: 750,
                  color: activityPriceUpload ? '#2458d3' : 'text.secondary',
                  borderColor: activityPriceUpload ? '#8eacff' : '#d7dde8',
                  bgcolor: activityPriceUpload ? '#edf3ff' : '#fff',
                  '&:hover': { borderColor: '#7c9fff', bgcolor: activityPriceUpload ? '#e4edff' : '#f7f9fc' },
                }}
              >
                {activityPriceUpload ? '活动价已开启' : '活动价上传'}
              </Button>
            </Stack>
            {pricing?.applyState?.error ? <Typography variant="caption" color="error.main" noWrap title={pricing.applyState.error}>{pricing.applyState.error}</Typography> : null}
          </Box>
          <CollectionProductPricingSummary pricing={pricing} />
        </Box>
        <Box
          data-testid="collection-package-fields"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.8, minHeight: 42, px: 1, py: 0.55, border: '1px solid #e7ebf2', borderRadius: 1.1, bgcolor: '#f7f9fc' }}
        >
          <Box sx={{ width: 88, flex: '0 0 88px' }}>
            <Typography variant="caption" fontWeight={800} color="text.primary">包裹规格</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10.5 }}>用于自动匹配运费</Typography>
          </Box>
          <TextField size="small" label="重量" value={draft.weightG} onChange={(event) => onChange({ weightG: event.target.value })} inputProps={{ 'aria-label': '重量（g）' }} InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">g</Typography> }} sx={compactPackageFieldSx} />
          <TextField size="small" label="长度" value={draft.packageLengthCm} onChange={(event) => onChange({ packageLengthCm: event.target.value })} inputProps={{ 'aria-label': '长（cm）' }} InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">cm</Typography> }} sx={compactPackageFieldSx} />
          <TextField size="small" label="宽度" value={draft.packageWidthCm} onChange={(event) => onChange({ packageWidthCm: event.target.value })} inputProps={{ 'aria-label': '宽（cm）' }} InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">cm</Typography> }} sx={compactPackageFieldSx} />
          <TextField size="small" label="高度" value={draft.packageHeightCm} onChange={(event) => onChange({ packageHeightCm: event.target.value })} inputProps={{ 'aria-label': '高（cm）' }} InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">cm</Typography> }} sx={compactPackageFieldSx} />
          <Stack
            data-testid="collection-upload-target-controls"
            direction="row"
            alignItems="center"
            spacing={0.7}
            sx={{ flex: '1 1 auto', minWidth: 0, ml: 0.35 }}
          >
            <Button
              size="small"
              variant="outlined"
              disabled={!selectedShopIds.length || enabledCount === 0}
              onClick={openBatchStock}
              sx={{ minWidth: 72, height: 34, borderRadius: 1, fontWeight: 750, bgcolor: '#fff' }}
            >
              库存
            </Button>
            <CollectionListingShopPicker
              compact
              shops={shops}
              selectedShopIds={selectedShopIds}
              onChange={onChangeSelectedShops}
            />
            <Button
              size="small"
              variant="outlined"
              disabled={!enabledCount || !skuDefinitions.length || attributeBatchState.status === 'pending'}
              onClick={fillSkuAttributes}
              title={attributeBatchState.error || attributeBatchState.message || '批量填写启用 SKU 的规格属性与商品颜色'}
              sx={{ minWidth: 116, height: 34, borderRadius: 1, fontWeight: 750, bgcolor: '#fff', whiteSpace: 'nowrap' }}
            >
              {attributeBatchState.status === 'pending' ? '属性填充中…' : '一键填充属性'}
            </Button>
            {attributeBatchState.status === 'success' || attributeBatchState.status === 'error' ? (
              <Typography
                variant="caption"
                color={attributeBatchState.status === 'error' ? 'error.main' : 'text.secondary'}
                noWrap
                title={attributeBatchState.error || attributeBatchState.message}
                sx={{ maxWidth: 150 }}
              >
                {attributeBatchState.error || attributeBatchState.message}
              </Typography>
            ) : null}
          </Stack>
          {activityPriceUpload ? (
            <Box sx={{ px: 1.1, py: 0.55, borderRadius: 1, bgcolor: '#edf3ff', color: '#315db8', fontSize: 11.5, fontWeight: 750, whiteSpace: 'nowrap' }}>
              50% 活动：原价 2× · 成交利润不变
            </Box>
          ) : null}
        </Box>
      </Box>
      <TableContainer
        data-testid="collection-sku-table-viewport"
        data-layout-fill="remaining"
        sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}
      >
        <Table stickyHeader size="small" aria-label="Ozon SKU 价格编辑">
          <TableHead><TableRow sx={{ '& .MuiTableCell-head': { bgcolor: '#f5f7fb', color: '#526078', fontSize: 12.5, fontWeight: 800, borderBottomColor: '#e4e9f1' } }}>
            <TableCell sx={{ width: 64 }}>启用</TableCell><TableCell sx={{ minWidth: 150 }}>来源规格</TableCell><TableCell sx={{ minWidth: 130 }}>规格属性</TableCell><TableCell sx={{ minWidth: 125 }}>商品颜色</TableCell><TableCell sx={{ minWidth: 160 }}>Ozon 货号</TableCell>
            <TableCell sx={{ minWidth: 105 }}>SKU 采购价 ¥</TableCell><TableCell sx={{ minWidth: 110 }}>{activityPriceUpload ? '活动成交价 ¥' : '销售价 ¥'}</TableCell><TableCell sx={{ minWidth: 110 }}>{activityPriceUpload ? '活动原价 ¥' : '划线价 ¥'}</TableCell><TableCell sx={{ minWidth: 110 }}>最低价 ¥</TableCell>
            {selectedShopRows.map((shop) => (
              <React.Fragment key={shop.shopId}>
                <TableCell sx={{ minWidth: 105 }} title={shop.label}>{shop.name}库存</TableCell>
                <TableCell sx={{ minWidth: 170 }} title={shop.label}>{shop.name}仓库</TableCell>
              </React.Fragment>
            ))}
          </TableRow></TableHead>
          <TableBody>{draft.skus.map((sku, index) => (
            <TableRow key={`${sku.sourceSkuId}-${index}`} hover>
              <TableCell><Switch size="small" checked={sku.enabled !== false} onChange={(event) => onChangeSku(index, { enabled: event.target.checked })} inputProps={{ 'aria-label': `启用 SKU ${index + 1}` }} /></TableCell>
              <TableCell><Typography variant="body2" fontWeight={650} noWrap title={sku.sourceSkuName}>{sku.sourceSkuName}</Typography></TableCell>
              <TableCell>
                <Typography variant="body2" fontWeight={650} noWrap title={collectionSkuAttributeSummary(sku, specificationDefinitions) || '未填写'}>
                  {collectionSkuAttributeSummary(sku, specificationDefinitions) || '未填写'}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" fontWeight={700} noWrap title={listingAttributeDisplayValue(sku.attributeValues?.[String(colorDefinition?.id || '')]) || '未填写'}>
                  {listingAttributeDisplayValue(sku.attributeValues?.[String(colorDefinition?.id || '')]) || '未填写'}
                </Typography>
              </TableCell>
              <TableCell><TextField size="small" value={sku.offerId} inputProps={{ 'aria-label': `Ozon 货号 ${index + 1}`, maxLength: 30, readOnly: true }} sx={fieldSx} /></TableCell>
              <TableCell><Typography variant="body2" fontWeight={750}>{sku.sourcePriceCny ? `¥ ${sku.sourcePriceCny}` : '未采集'}</Typography></TableCell>
              <TableCell><TextField size="small" value={sku.priceCny || ''} onChange={(event) => onChangeSku(index, buildCollectionActivitySalePriceChanges(event.target.value, activityPriceUpload))} inputProps={{ 'aria-label': `人民币销售价 ${index + 1}`, inputMode: 'decimal' }} sx={fieldSx} /></TableCell>
              <TableCell><TextField size="small" value={sku.oldPriceCny || ''} onChange={(event) => onChangeSku(index, { oldPriceCny: event.target.value, oldPrice: '', pricingSnapshot: {} })} inputProps={{ 'aria-label': `人民币划线价 ${index + 1}`, inputMode: 'decimal' }} sx={fieldSx} /></TableCell>
              <TableCell><TextField size="small" value={sku.minPriceCny || ''} onChange={(event) => onChangeSku(index, { minPriceCny: event.target.value, minPrice: '', pricingSnapshot: {} })} inputProps={{ 'aria-label': `人民币最低价 ${index + 1}`, inputMode: 'decimal' }} sx={fieldSx} /></TableCell>
              {selectedShopRows.map((shop) => {
                const inventory = getCollectionSkuShopInventory(sku, shop.shopId);
                return (
                  <React.Fragment key={shop.shopId}>
                    <TableCell>
                      <TextField
                        size="small"
                        value={inventory.stock}
                        onChange={(event) => changeShopInventory(sku, index, shop.shopId, { stock: event.target.value })}
                        inputProps={{ 'aria-label': `Ozon 库存 ${shop.shopId} ${index + 1}` }}
                        sx={fieldSx}
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        select
                        size="small"
                        fullWidth
                        value={inventory.warehouseId}
                        onChange={(event) => changeShopInventory(sku, index, shop.shopId, { warehouseId: event.target.value })}
                        inputProps={{ 'aria-label': `Ozon 仓库 ${shop.shopId} ${index + 1}` }}
                        sx={fieldSx}
                      >
                        <MenuItem value="">不写库存</MenuItem>
                        {shop.warehouses.map((warehouse) => (
                          <MenuItem key={warehouse.rawId || warehouse.id} value={String(warehouse.rawId || warehouse.id)}>
                            {warehouse.name || warehouse.rawId || warehouse.id}
                          </MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                  </React.Fragment>
                );
              })}
            </TableRow>
          ))}</TableBody>
        </Table>
      </TableContainer>
      <CollectionProductSkuAttributeWorkspace
        draft={draft}
        definitions={skuDefinitions}
        optionsByAttributeId={optionsByAttributeId}
        onChangeSkuAttribute={onChangeSkuAttribute}
        onSearchAttributeOptions={onSearchAttributeOptions}
      />
      <CollectionProductBatchStockDialog
        open={batchStockOpen}
        shops={shops}
        selectedShopIds={selectedShopIds}
        warehousesByShopId={warehousesByShopId}
        warehouseStatesByShopId={warehouseStatesByShopId}
        enabledSkuCount={enabledCount}
        defaultInventoryByShopId={defaultInventoryByShopId}
        onClose={() => setBatchStockOpen(false)}
        onReload={onReloadWarehouses}
        onApply={onApplyBatchStock}
      />
    </Stack>
  );
}

function PreviewFact({ label, value }) {
  return <Box sx={{ py: 1, borderBottom: '1px solid #edf0f4' }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" fontWeight={750}>{value || '—'}</Typography></Box>;
}

function CollectionListingShopPicker({ shops = [], selectedShopIds = [], onChange, compact = false }) {
  const [anchorEl, setAnchorEl] = React.useState(null);
  const availableShopIds = shops.map((shop) => String(shop.id || shop.shopId || '').trim()).filter(Boolean);
  const selected = new Set(selectedShopIds.map(String));
  const toggleShop = (shopId) => {
    const next = new Set(selected);
    if (next.has(shopId)) next.delete(shopId);
    else next.add(shopId);
    onChange?.(availableShopIds.filter((id) => next.has(id)));
  };
  return (
    <>
      <Button
        size={compact ? 'small' : 'medium'}
        variant="outlined"
        startIcon={<StorefrontRounded />}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        aria-label="选择上传店铺"
        sx={{ minWidth: compact ? 148 : 168, height: compact ? 34 : undefined, justifyContent: 'flex-start', whiteSpace: 'nowrap', bgcolor: '#fff', borderRadius: 1, fontWeight: 750 }}
      >
        选择店铺 · {selected.size}
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        slotProps={{ paper: { sx: { width: 360, maxHeight: 420, mt: 0.5 } } }}
      >
        <MenuItem
          onClick={() => onChange?.(availableShopIds)}
          disabled={availableShopIds.length > 0 && selected.size === availableShopIds.length}
        >
          <Checkbox checked={availableShopIds.length > 0 && selected.size === availableShopIds.length} />
          <Typography fontWeight={750}>全选店铺</Typography>
        </MenuItem>
        {shops.map((shop) => {
          const shopId = String(shop.id || shop.shopId || '').trim();
          return (
            <MenuItem key={shopId} onClick={() => toggleShop(shopId)}>
              <Checkbox checked={selected.has(shopId)} />
              <Typography variant="body2" noWrap>{shopLabel(shop)}</Typography>
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}

export function CollectionProductListingPreviewStep({
  preview,
  state,
  selectedShopIds = [],
  onCreatePreview,
  onCancelPreview,
  onSubmit,
}) {
  const [confirmedOperationId, setConfirmedOperationId] = React.useState('');
  const confirmed = Boolean(preview?.operationId && confirmedOperationId === preview.operationId);
  if (!preview) {
    const previewing = state?.status === 'previewing';
    const retryable = ['error', 'cancelled'].includes(state?.status);
    const progressCurrent = Number(state?.progress?.current || 0);
    const progressTotal = Number(state?.progress?.total || 0);
    return (
      <Stack spacing={1.5} sx={{ height: '100%', p: 2.25, overflowY: 'auto' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Box>
            <Typography variant="h6" fontWeight={850}>{retryable ? '上架预览需要处理' : '正在生成完整上架预览'}</Typography>
            <Typography variant="body2" color="text.secondary">进入本页后自动校验，不会自动上传；核对完成后仍需你手动确认。</Typography>
          </Box>
          <Chip size="small" variant="outlined" icon={<StorefrontRounded />} label={`已选 ${selectedShopIds.length} 家店铺`} />
        </Stack>

        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1.25, borderColor: retryable ? 'error.light' : '#dce4f3', bgcolor: '#fff' }}>
          <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'center' }} spacing={1.5}>
            <Box sx={{ width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: 1, bgcolor: retryable ? '#fff3f2' : '#eef3ff' }}>
              {previewing ? <CircularProgress size={24} thickness={5} /> : <StorefrontRounded color={retryable ? 'error' : 'primary'} />}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body1" fontWeight={800}>{previewing ? '正在准备可提交的最终快照' : retryable ? '本次预览没有生成成功' : '正在准备预览'}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {state?.message || '正在保存图片和商品草稿，并逐店校验仓库、类目、属性、SKU、价格与库存。'}
              </Typography>
            </Box>
            {previewing ? (
              <Button variant="outlined" color="warning" onClick={onCancelPreview}>取消生成</Button>
            ) : retryable ? (
              <Button variant="contained" disabled={!selectedShopIds.length} onClick={onCreatePreview}>重新生成预览</Button>
            ) : null}
          </Stack>
          {progressTotal > 0 ? (
            <Typography variant="caption" color="primary.main" display="block" sx={{ mt: 1.25, pl: { md: 7 } }}>
              已完成 {Math.min(progressCurrent, progressTotal)} / {progressTotal}
            </Typography>
          ) : null}
        </Paper>

        {state?.error ? <Alert severity="error">{state.error}</Alert> : null}

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 1 }}>
          {selectedShopIds.map((shopId, index) => (
            <Paper key={shopId} variant="outlined" sx={{ p: 1.35, borderRadius: 1, borderColor: '#e1e6ef', bgcolor: '#fff' }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <Box minWidth={0}>
                  <Typography variant="body2" fontWeight={800}>上传店铺 {index + 1}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap display="block">{shopId}</Typography>
                </Box>
                <Chip size="small" color={retryable ? 'error' : 'primary'} variant="outlined" label={retryable ? '待重试' : previewing ? '校验中' : '待校验'} />
              </Stack>
            </Paper>
          ))}
        </Box>

        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1, borderColor: '#e4e9f1', bgcolor: '#fbfcff' }}>
          <Typography variant="caption" color="text.secondary">本页固定校验范围</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 0.75 }}>
            {['目标店铺', '仓库库存', '商品图片', 'Ozon 类目', '商品属性', 'SKU 与价格'].map((label) => (
              <Chip key={label} size="small" variant="outlined" label={label} sx={{ bgcolor: '#fff' }} />
            ))}
          </Stack>
        </Paper>
      </Stack>
    );
  }
  const readyShopPreviews = preview.multiShop
    ? (preview.shopPreviews || []).filter((item) => item.status === 'ready' && item.preview)
    : [];
  const representativePreview = readyShopPreviews[0]?.preview || preview;
  const products = representativePreview.products || [representativePreview.product].filter(Boolean);
  const prices = representativePreview.prices || [representativePreview.price].filter(Boolean);
  const activityPriceUpload = representativePreview.draftSnapshot?.activityPriceUpload === true;
  return (
    <Stack spacing={1.5} sx={{ p: 2.25, height: '100%', overflowY: 'auto' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Box><Typography variant="h6" fontWeight={850}>上架前最后核对</Typography><Typography variant="body2" color="text.secondary">共 {products.length} 个 SKU；{activityPriceUpload ? '活动原价按成交价 2 倍写入；' : ''}每个店铺独立上传并回读。</Typography></Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Chip size="small" variant="outlined" icon={<StorefrontRounded />} label={`已选 ${selectedShopIds.length} 家店铺`} />
          {state?.status === 'previewing' ? (
            <Button variant="outlined" color="warning" onClick={onCancelPreview}>取消重新生成</Button>
          ) : (
            <Button variant="outlined" disabled={!selectedShopIds.length} onClick={onCreatePreview}>重新生成预览</Button>
          )}
        </Stack>
      </Stack>
      {state?.status === 'previewing' && state?.message ? <Alert severity="info">{state.message}</Alert> : null}
      {preview.multiShop ? (
        <Box data-testid="collection-listing-shop-previews" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 1 }}>
          {(preview.shopPreviews || []).map((item) => (
            <Paper key={item.shopId} variant="outlined" sx={{ p: 1.25, borderRadius: 1, borderColor: item.status === 'ready' ? 'success.light' : 'error.light' }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <Typography variant="body2" fontWeight={800} noWrap>{item.shopLabel}</Typography>
                <Chip size="small" color={item.status === 'ready' ? 'success' : 'error'} label={item.status === 'ready' ? '预览就绪' : '无法上传'} />
              </Stack>
              <Typography variant="caption" color={item.status === 'ready' ? 'text.secondary' : 'error.main'} display="block" mt={0.5}>
                {item.status === 'ready' ? `仓库：${item.warehouseName || '本次不写库存'}` : item.error}
              </Typography>
            </Paper>
          ))}
        </Box>
      ) : null}
      {representativePreview.validation?.warnings?.length ? <Alert severity="warning">{representativePreview.validation.warnings.join('；')}</Alert> : null}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 1.25 }}>
        <PreviewFact label="上传店铺" value={preview.multiShop ? `${preview.readyCount}/${preview.selectedShopIds?.length || 0} 家已就绪` : representativePreview.draftSnapshot?.shopId} />
        <PreviewFact label="Ozon 类目" value={representativePreview.product?.description_category_id} />
        <PreviewFact label="类型" value={representativePreview.product?.type_id} />
        <PreviewFact label="图片 / 属性" value={`${representativePreview.product?.images?.length || 0} 张 / ${representativePreview.product?.attributes?.length || 0} 项`} />
      </Box>
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 0.75, maxHeight: 410 }}>
        <Table stickyHeader size="small"><TableHead><TableRow><TableCell>货号</TableCell><TableCell>标题</TableCell><TableCell>{activityPriceUpload ? '活动成交价（人民币）' : '销售价（人民币）'}</TableCell><TableCell>{activityPriceUpload ? '活动原价（人民币）' : '划线价（人民币）'}</TableCell><TableCell>库存</TableCell></TableRow></TableHead>
          <TableBody>{products.map((product, index) => {
            const sourceSku = representativePreview.draftSnapshot?.skus?.find((item) => item.offerId === product.offer_id) || {};
            return (
              <TableRow key={product.offer_id}><TableCell>{product.offer_id}</TableCell><TableCell>{product.name}</TableCell><TableCell>¥ {prices[index]?.price || sourceSku.priceCny || '—'}</TableCell><TableCell>¥ {prices[index]?.old_price || sourceSku.oldPriceCny || '—'}</TableCell><TableCell>{representativePreview.stocks?.find((item) => item.offer_id === product.offer_id)?.stock ?? '不写入'}</TableCell></TableRow>
            );
          })}</TableBody>
        </Table>
      </TableContainer>
      <FormControlLabel
        control={<Checkbox checked={confirmed} onChange={(event) => setConfirmedOperationId(event.target.checked ? preview.operationId : '')} />}
        label={`我已核对 ${preview.multiShop ? preview.readyCount : 1} 个上传店铺、类目、标题属性、图片、价格、尺寸和库存`}
      />
      <Box><Button variant="contained" startIcon={<CloudUploadRounded />} disabled={!confirmed || !products.length || state?.status === 'submitting' || state?.status === 'previewing'} onClick={onSubmit}>{state?.status === 'submitting' ? '上传并回读中…' : `上传到 ${preview.multiShop ? preview.readyCount : 1} 个店铺`}</Button></Box>
    </Stack>
  );
}

export function CollectionProductListingReadbackStep({ state, onBackToPreview, onResumeReadBack }) {
  const resumable = (state?.result?.shopResults || []).some((shopResult) => (
    (shopResult?.result?.results || []).some((item) => {
      const readBack = item?.response?.readBack;
      const readBackStatus = String(
        readBack?.status || item?.readBackStatus || '',
      ).toLowerCase();
      if (
        !['pending', 'mismatch'].includes(readBackStatus) ||
        readBack?.verification?.terminal === true
      ) return false;
      if (item?.kind === 'info') {
        return Boolean(readBack?.importTask?.failed !== true && readBack?.importTask?.taskId);
      }
      return readBackStatus === 'pending' &&
        ['price', 'stock'].includes(item?.kind) &&
        item?.writeConnected === true;
    })
  ));
  return (
    <Stack spacing={1.5} sx={{ p: 2.25 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        {state?.status === 'completed' ? <CheckCircleRounded color="success" /> : null}
        <Box><Typography variant="h6" fontWeight={850}>上传与 Ozon 回读</Typography><Typography variant="body2" color="text.secondary">只有每一步回读一致，任务才算完成。</Typography></Box>
      </Stack>
      <ListingTaskStatusCard listingState={state} />
      {state?.status !== 'submitting' && state?.status !== 'completed' ? (
        <Stack direction="row" spacing={1}>
          {resumable ? <Button variant="contained" onClick={onResumeReadBack}>继续回读（不重复上传）</Button> : null}
          <Button variant="outlined" onClick={onBackToPreview}>返回预览</Button>
        </Stack>
      ) : null}
    </Stack>
  );
}
