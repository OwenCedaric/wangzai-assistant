import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  isOzonAttributeCollection,
  isOzonAttributeDictionary,
  isOzonAttributeManualEntryAllowed,
  translateProductAttributeValue,
} from '../../../entities/product/productAttributes.jsx';

function isWideAttribute(item = {}) {
  const label = String(item.label || '').trim();
  const value = String(item.value || '').trim();
  return (
    value.length > 80 ||
    /描述|标签|富内容|说明|商品名称|hashtag|хештег|характерист|description|rich content/iu.test(label)
  );
}

function isTagAttribute(item = {}) {
  const id = String(item.attributeId || item.id || '').trim();
  return id === '23171' || /标签|hashtag|хештег/iu.test(String(item.label || ''));
}

function isCurrentProductRequiredAttribute(item = {}) {
  const id = String(item.attributeId || item.id || '').trim();
  // 8229 is the category's product-type guide. Existing products returned by
  // Ozon often omit it, so it must not be presented as a required value in
  // the existing-product editor.
  return Boolean(item.required) && id !== '8229';
}

function getAttributePlaceholder(item = {}) {
  if (isTagAttribute(item)) return '可填写多个标签，用逗号或换行分隔';
  if (isBooleanAttribute(item)) return '请选择是或否';
  if (isDictionaryAttribute(item) && isOzonAttributeManualEntryAllowed(item)) return '请选择或直接输入 Ozon 选项';
  if (isDictionaryAttribute(item))
    return isCurrentProductRequiredAttribute(item) ? '请选择 Ozon 选项' : '请选择或搜索 Ozon 选项';
  return isCurrentProductRequiredAttribute(item) ? '必填，Ozon 未返回值' : '未填写';
}

function isDictionaryAttribute(item = {}) {
  return isOzonAttributeDictionary(item);
}

function isCollectionAttribute(item = {}) {
  return isOzonAttributeCollection(item);
}

function isBooleanAttribute(item = {}) {
  const valueType = String(
    item.valueType ??
      item.value_type ??
      item.definition?.valueType ??
      item.definition?.value_type ??
      item.definition?.type ??
      ''
  ).toLowerCase();
  return valueType.includes('boolean') || valueType === 'bool';
}

function splitAttributeValues(value) {
  return String(value ?? '')
    .split(/[、,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function getAttributeInputType(item = {}) {
  const valueType = String(
    item.valueType ??
      item.value_type ??
      item.definition?.valueType ??
      item.definition?.value_type ??
      item.definition?.type ??
      ''
  ).toLowerCase();
  if (valueType.includes('integer') || valueType.includes('decimal') || valueType.includes('number')) return 'number';
  return 'text';
}

function getAttributeOptions(item = {}, optionsById = {}) {
  const id = String(item.attributeId || item.id || '').trim();
  const options = Array.isArray(optionsById?.[id]) ? optionsById[id] : [];
  const seen = new Set();
  const normalized = options
    .map((option) => ({
      id: String(option?.id ?? option?.valueId ?? '').trim(),
      value: String(option?.value ?? option?.valueText ?? option?.label ?? '').trim(),
      label: String(option?.label ?? option?.valueText ?? option?.value ?? '').trim(),
      info: String(option?.info ?? '').trim(),
    }))
    .filter((option) => option.value && !seen.has(option.value) && seen.add(option.value));
  splitAttributeValues(item.value).forEach((value) => {
    const translatedValue = translateProductAttributeValue(value);
    const alreadyIncluded = normalized.some(
      (option) => option.value === value || translateProductAttributeValue(option.label) === translatedValue
    );
    if (!alreadyIncluded) normalized.unshift({ id: '', value, label: value, info: '' });
  });
  return normalized;
}

function getDictionaryOptionLabel(option = {}) {
  return translateProductAttributeValue(option?.label ?? option?.value ?? '');
}

function findSelectedDictionaryOption(options = [], value = '') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const translated = translateProductAttributeValue(text);
  return (
    options.find((option) => option.value === text || getDictionaryOptionLabel(option) === translated) || {
      id: '',
      value: text,
      label: text,
      info: '',
    }
  );
}

function ProductDictionaryAttributeInput({
  item,
  options,
  collection,
  manualEntryAllowed,
  optionLoading,
  value,
  loadAttributeOptions,
  updateAttributeField,
  disabled,
}) {
  const searchTimerRef = React.useRef(null);
  React.useEffect(
    () => () => {
      if (searchTimerRef.current) globalThis.clearTimeout(searchTimerRef.current);
    },
    []
  );

  const currentValues = collection ? splitAttributeValues(value) : [String(value ?? '').trim()].filter(Boolean);
  const selectedOptions = currentValues
    .map((currentValue) => findSelectedDictionaryOption(options, currentValue))
    .filter(Boolean);
  const selectedValue = collection ? selectedOptions : selectedOptions[0] || null;
  const normalizeSelectedOption = (option) =>
    typeof option === 'string' ? { id: '', value: option.trim(), label: option.trim(), info: '' } : option;

  return (
    <Autocomplete
      className={`product-attribute-autocomplete${collection ? ' product-attribute-autocomplete-collection' : ''}`}
      multiple={collection}
      freeSolo={manualEntryAllowed}
      autoSelect={manualEntryAllowed}
      options={options}
      value={selectedValue}
      loading={optionLoading}
      disabled={disabled}
      disableCloseOnSelect={collection}
      filterSelectedOptions={collection}
      limitTags={collection ? 2 : undefined}
      getOptionLabel={(option) => getDictionaryOptionLabel(normalizeSelectedOption(option))}
      isOptionEqualToValue={(option, selected) =>
        Boolean(
          option.id && normalizeSelectedOption(selected)?.id && option.id === normalizeSelectedOption(selected).id
        ) ||
        option.value === normalizeSelectedOption(selected)?.value ||
        getDictionaryOptionLabel(option) === getDictionaryOptionLabel(normalizeSelectedOption(selected))
      }
      onOpen={() => loadAttributeOptions?.(item)}
      onInputChange={(_event, inputValue, reason) => {
        if (reason !== 'input') return;
        if (searchTimerRef.current) globalThis.clearTimeout(searchTimerRef.current);
        const searchText = String(inputValue || '').trim();
        if (!searchText) return;
        const normalizedSearch = searchText.toLocaleLowerCase('zh-CN');
        const hasLocalMatch = options.some((option) =>
          getDictionaryOptionLabel(option).toLocaleLowerCase('zh-CN').includes(normalizedSearch)
        );
        if (hasLocalMatch) return;
        searchTimerRef.current = globalThis.setTimeout(() => {
          loadAttributeOptions?.(item, searchText);
        }, 450);
      }}
      onChange={(_event, nextSelected) => {
        const selected = (Array.isArray(nextSelected) ? nextSelected : nextSelected ? [nextSelected] : [])
          .map(normalizeSelectedOption)
          .filter((option) => option?.value);
        const nextValue = collection ? selected.map((option) => option.value).join('、') : selected[0]?.value || '';
        const dictionaryValueIds = selected.map((option) => option.id || null);
        updateAttributeField(item.id)({ target: { value: nextValue, dictionaryValueIds } });
      }}
      noOptionsText={
        optionLoading
          ? '正在读取 Ozon 选项…'
          : manualEntryAllowed
            ? '没有匹配项，可直接输入并按回车'
            : '没有匹配的 Ozon 选项'
      }
      loadingText="正在读取 Ozon 选项…"
      slotProps={{ paper: { className: 'product-attribute-autocomplete-paper' } }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          placeholder={collection && currentValues.length > 0 ? '' : getAttributePlaceholder(item)}
          inputProps={{ ...params.inputProps, 'aria-label': item.label }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {optionLoading ? <CircularProgress color="inherit" size={14} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}

function isHiddenAttribute(item = {}) {
  const id = String(item.attributeId || item.id || '').trim();
  const label = String(item.label || '').trim();
  const hiddenMediaAttributeIds = new Set([
    '11254',
    '8789',
    '8790',
    '21837',
    '21841',
    '21842',
    '21843',
    '21844',
    '21845',
    '21846',
  ]);
  return (
    hiddenMediaAttributeIds.has(id) ||
    /富内容|富文本|rich[ _-]?content|rich_content_json|视频|video|видео|pdf|PDF|документ[ _-]?pdf|файл[ _-]?pdf/iu.test(
      label
    )
  );
}

function isRecommendedAttribute(item = {}) {
  if (item.required) return false;
  const definition = item.definition || {};
  const explicitlyRecommended = Boolean(
    definition.isRecommended ??
    definition.is_recommended ??
    definition.recommended ??
    definition.isAspect ??
    definition.is_aspect
  );
  if (explicitlyRecommended) return true;
  const label = String(item.label || '').trim();
  return /品牌|材质|颜色|色彩|尺寸|规格|型号|适用|用途|功能|特点|卖点|关键词|标签|商品描述|富内容|产地|成分|形状|风格|套装|受众|年龄|性别|场景|brand|material|colou?r|size|model|description|feature|usage|country|composition|style|age|gender|бренд|материал|цвет|размер|модель|описание|назначение|особенности|страна|состав|стиль|возраст|комплект/iu.test(
    label
  );
}

function attributeOrderPriority(item = {}) {
  const id = String(item.attributeId || item.id || '').trim();
  const label = String(item.label || '').trim();
  if (id === '4180' || /商品标题|商品名称|标题|title/iu.test(label)) return 0;
  if (/品牌|brand|бренд/iu.test(label)) return 10;
  if (/型号|型号名称|model|модель/iu.test(label)) return 20;
  if (/类型|type|тип|вид/iu.test(label)) return 30;
  if (/颜色|色彩|颜色名称|colou?r|цвет/iu.test(label)) return 40;
  if (/材质|成分|组成|material|composition|материал|состав/iu.test(label)) return 45;
  if (/尺寸|规格|size|размер/iu.test(label)) return 50;
  if (/描述|话题标签|标签|description|hashtag|описан|хештег/iu.test(label)) return 60;
  return 100;
}

function orderAttributeRows(attributeRows = []) {
  return [...(Array.isArray(attributeRows) ? attributeRows : [])].sort((left, right) => {
    if (attributeOrderPriority(left) !== attributeOrderPriority(right)) {
      return attributeOrderPriority(left) - attributeOrderPriority(right);
    }
    if (Boolean(left.required) !== Boolean(right.required)) return left.required ? -1 : 1;
    const leftRecommended = isRecommendedAttribute(left);
    const rightRecommended = isRecommendedAttribute(right);
    if (leftRecommended !== rightRecommended) return leftRecommended ? -1 : 1;
    if (Boolean(left.filled) !== Boolean(right.filled)) return left.filled ? -1 : 1;
    return String(left.label || '').localeCompare(String(right.label || ''), 'zh-CN');
  });
}

export function ProductAttributeEditor({
  attributeRows,
  attributeOptionsById = {},
  attributeOptionsLoading = {},
  loadAttributeOptions,
  form,
  updateAttributeField,
  saving,
  attributeLoading,
  attributeContextMeta = {},
}) {
  const rows = orderAttributeRows(
    (Array.isArray(attributeRows) ? attributeRows : []).filter((item) => !isHiddenAttribute(item))
  );
  const filledCount = rows.filter((item) => item.filled).length;
  const recommendedCount = rows.filter(isRecommendedAttribute).length;
  return (
    <Box className="product-editor-right">
      <Box className="product-editor-section product-attribute-section">
        <Stack
          direction="row"
          alignItems="flex-start"
          justifyContent="space-between"
          spacing={1.5}
          mb={1.5}
          className="product-attribute-header"
        >
          <Box minWidth={0}>
            <Typography variant="h6">当前商品可编辑属性</Typography>
          </Box>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            {attributeLoading ? <Chip size="small" color="primary" variant="outlined" label="读取中" /> : null}
            {recommendedCount ? (
              <Chip size="small" color="success" variant="outlined" label={`建议加分 ${recommendedCount}`} />
            ) : null}
            <Chip size="small" variant="outlined" label={`已填 ${filledCount} / 可填 ${rows.length}`} />
          </Stack>
        </Stack>
        {attributeContextMeta?.warning ? (
          <Typography className="product-attribute-warning" variant="caption">
            {attributeContextMeta.warning}
          </Typography>
        ) : null}
        <Box className="product-attribute-grid">
          {rows.length > 0 ? (
            rows.map((item) => {
              const wide = isWideAttribute(item);
              const recommended = isRecommendedAttribute(item);
              const dictionary = isDictionaryAttribute(item);
              const booleanAttribute = isBooleanAttribute(item);
              const collection = dictionary && isCollectionAttribute(item);
              const manualEntryAllowed = dictionary && isOzonAttributeManualEntryAllowed(item);
              const options = booleanAttribute
                ? [
                    { id: '', value: 'false', label: '否', info: '' },
                    { id: '', value: 'true', label: '是', info: '' },
                  ]
                : dictionary
                  ? getAttributeOptions(item, attributeOptionsById)
                  : [];
              const optionLoading = dictionary && Boolean(attributeOptionsLoading?.[item.attributeId || item.id]);
              return (
                <Box
                  key={item.id}
                  className={`product-attribute-item${item.filled ? '' : ' empty'}${wide ? ' is-wide' : ''}${recommended ? ' is-recommended' : ''}`}
                >
                  <Stack direction="row" alignItems="center" spacing={0.75} className="product-attribute-label-row">
                    <Typography variant="caption" color="text.secondary" noWrap title={item.label}>
                      {item.label}
                    </Typography>
                    {isCurrentProductRequiredAttribute(item) ? (
                      <Chip size="small" color="warning" variant="outlined" label="必填" />
                    ) : null}
                    {recommended ? (
                      <Chip
                        size="small"
                        color="success"
                        variant="outlined"
                        label="建议加分"
                        title="建议优先完善，有助于商品信息完整度、搜索匹配和购买判断；不代表 Ozon 官方分值"
                      />
                    ) : null}
                  </Stack>
                  {dictionary ? (
                    <ProductDictionaryAttributeInput
                      item={item}
                      options={options}
                      collection={collection}
                      manualEntryAllowed={manualEntryAllowed}
                      optionLoading={optionLoading}
                      value={form.attributeValues?.[item.id] ?? ''}
                      loadAttributeOptions={loadAttributeOptions}
                      updateAttributeField={updateAttributeField}
                      disabled={saving || attributeLoading}
                    />
                  ) : booleanAttribute ? (
                    <TextField
                      select
                      size="small"
                      value={form.attributeValues?.[item.id] ?? ''}
                      onChange={(event) => {
                        updateAttributeField(item.id)({
                          target: { value: event.target.value, dictionaryValueIds: [] },
                        });
                      }}
                      placeholder={getAttributePlaceholder(item)}
                      disabled={saving || attributeLoading}
                      fullWidth
                      SelectProps={{
                        displayEmpty: true,
                        renderValue: (selected) => {
                          return translateProductAttributeValue(selected) || '请选择是或否';
                        },
                      }}
                    >
                      <MenuItem value="" disabled>
                        请选择是或否
                      </MenuItem>
                      {options.map((option) => (
                        <MenuItem key={`${item.id}-${option.value}`} value={option.value}>
                          {translateProductAttributeValue(option.label)}
                        </MenuItem>
                      ))}
                    </TextField>
                  ) : (
                    <TextField
                      size="small"
                      value={form.attributeValues?.[item.id] ?? ''}
                      onChange={updateAttributeField(item.id)}
                      placeholder={getAttributePlaceholder(item)}
                      disabled={saving || attributeLoading}
                      multiline={wide}
                      minRows={wide ? 2 : undefined}
                      maxRows={wide ? 3 : undefined}
                      type={wide ? 'text' : getAttributeInputType(item)}
                      fullWidth
                    />
                  )}
                </Box>
              );
            })
          ) : attributeLoading ? (
            <Box className="product-attribute-empty">
              <Typography variant="subtitle2">正在读取 Ozon 属性</Typography>
            </Box>
          ) : (
            <Box className="product-attribute-empty">
              <Typography variant="subtitle2">Ozon 未返回属性信息</Typography>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
