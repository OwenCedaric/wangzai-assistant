export {
  applyProductFeeExchangeRateToRows,
  getProductFeeRubToCnyRate,
  getProductRowCacheKey,
  mergeProductRows,
  normalizeOzonProductRow,
  setProductFeeRubToCnyRate,
} from '../../../services/productRowRuntime.js';
import { formatShopBindingTime } from '../../../shared/lib/dateTimeFormat.js';
import { profitModeOptions, profitTabConfig } from '../../../entities/profit/profitModeRules.jsx';
import {
  getWatermarkProfileSetting,
  hydrateWatermarkAssetReferences,
  prepareWatermarkProfileSetting,
  saveWatermarkProfileSetting,
} from './watermarkProfileSettingsService.js';
import {
  defaultWatermarkTemplates,
  WATERMARK_DEFAULT_TEXT_COLOR,
  WATERMARK_IMAGE_SIZE_MAX,
  WATERMARK_IMAGE_SIZE_MIN,
  WATERMARK_TEXT_SIZE_MAX,
  WATERMARK_TEXT_SIZE_MIN,
} from '../../../shared/config/appConfigCore.jsx';
import { formatDashboardInteger } from '../../../shared/lib/dashboardNumberFormat';
import BarChartRounded from '@mui/icons-material/BarChartRounded';
import PeopleAltRounded from '@mui/icons-material/PeopleAltRounded';
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';

export {
  hydrateOzonShopSettingsFromLocalFile,
  hydrateOzonShopSettingsWithRetry,
  normalizeOzonShopSettingsStore,
  normalizeSavedOzonShops,
  ozonShopSettingsMemory,
  readSavedActiveOzonShopId,
  readSavedOzonShops,
  readSavedOzonShopSettings,
  saveOzonShopPreferences,
  saveOzonShopSettings,
} from '../../../services/ozonShopSettingsStore';

export { formatShopBindingTime, profitModeOptions, profitTabConfig };

export function normalizeHexColor(value, fallback = WATERMARK_DEFAULT_TEXT_COLOR) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

export function normalizeWatermarkTemplate(template, index = 0, options = {}) {
  const fallback = defaultWatermarkTemplates[index] ?? defaultWatermarkTemplates[0];
  const allowEmptyName = Boolean(options.allowEmptyName);
  const rawName = template?.name ?? template?.templateName ?? fallback.name ?? '未命名模板';
  const name = String(rawName).trim();
  const scope = ['main', 'detail', 'all'].includes(template?.scope) ? template.scope : fallback.scope;
  const imageSize = Math.min(
    WATERMARK_IMAGE_SIZE_MAX,
    Math.max(WATERMARK_IMAGE_SIZE_MIN, Number(template?.imageSize ?? fallback.imageSize ?? 18))
  );
  const imageCenterMin = imageSize / 2;
  const imageCenterMax = 100 - imageCenterMin;
  return {
    id: String(template?.id || `watermark-template-${Date.now()}-${index}`),
    name: name || (allowEmptyName ? '' : '未命名模板'),
    scope,
    text: String(template?.text ?? fallback.text ?? ''),
    imageName: String(template?.imageName ?? ''),
    imageDataUrl: String(template?.imageDataUrl ?? ''),
    imageAssetId: String(template?.imageAssetId ?? ''),
    opacity: Math.min(100, Math.max(10, Number(template?.opacity ?? fallback.opacity ?? 70))),
    imageSize,
    imageX: Math.min(imageCenterMax, Math.max(imageCenterMin, Number(template?.imageX ?? fallback.imageX ?? 82))),
    imageY: Math.min(imageCenterMax, Math.max(imageCenterMin, Number(template?.imageY ?? fallback.imageY ?? 76))),
    textX: Math.min(96, Math.max(4, Number(template?.textX ?? fallback.textX ?? 32))),
    textY: Math.min(96, Math.max(4, Number(template?.textY ?? fallback.textY ?? 78))),
    textWidth: Math.min(90, Math.max(18, Number(template?.textWidth ?? fallback.textWidth ?? 42))),
    textSize: Math.min(
      WATERMARK_TEXT_SIZE_MAX,
      Math.max(WATERMARK_TEXT_SIZE_MIN, Number(template?.textSize ?? fallback.textSize ?? 32))
    ),
    textColor: normalizeHexColor(template?.textColor ?? fallback.textColor),
    wrapText: Boolean(template?.wrapText ?? fallback.wrapText ?? true),
    savedAt: String(template?.savedAt || ''),
  };
}

export function getDefaultWatermarkTemplates() {
  return defaultWatermarkTemplates.map((template, index) => normalizeWatermarkTemplate(template, index));
}

export let watermarkSettingsMemory = null;
let watermarkSettingsWriteQueue = Promise.resolve();
let watermarkSettingsLoadPromise = null;

export function normalizeWatermarkSettingsStore(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawTemplates = Array.isArray(source.templates) ? source.templates : Array.isArray(value) ? value : [];
  const templates = rawTemplates.length
    ? rawTemplates.map((template, index) => normalizeWatermarkTemplate(template, index))
    : getDefaultWatermarkTemplates();
  const requestedActiveId = String(source.activeTemplateId || '').trim();
  const activeTemplateId = templates.some((template) => template.id === requestedActiveId)
    ? requestedActiveId
    : (templates[0]?.id ?? '');
  return {
    version: 1,
    templates,
    activeTemplateId,
    updatedAt: String(source.updatedAt || ''),
  };
}

export function readSavedWatermarkSettings() {
  if (watermarkSettingsMemory) return watermarkSettingsMemory;
  return normalizeWatermarkSettingsStore({});
}

export function readSavedWatermarkTemplates() {
  return readSavedWatermarkSettings().templates;
}

export function readSavedActiveWatermarkTemplateId(templates) {
  const settings = readSavedWatermarkSettings();
  return templates.some((template) => template.id === settings.activeTemplateId)
    ? settings.activeTemplateId
    : (templates[0]?.id ?? '');
}

export function saveWatermarkTemplates(templates, activeTemplateId) {
  const nextStore = normalizeWatermarkSettingsStore({
    templates,
    activeTemplateId,
    updatedAt: new Date().toISOString(),
  });
  watermarkSettingsMemory = nextStore;
  const writePromise = watermarkSettingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const prepared = await prepareWatermarkProfileSetting(nextStore, normalizeWatermarkSettingsStore);
      const saved = await saveWatermarkProfileSetting(prepared.persistedValue);
      if (!saved?.setting?.value) throw new Error('local-api 未返回水印模板。');
      watermarkSettingsMemory = prepared.runtimeStore;
    });
  watermarkSettingsWriteQueue = writePromise.catch(() => undefined);
  writePromise.catch(() => undefined);
  return nextStore;
}

async function loadWatermarkSettingsFromLocalApiInternal() {
  const current = await getWatermarkProfileSetting();
  if (current?.setting?.value) {
    watermarkSettingsMemory = await hydrateWatermarkAssetReferences(
      current.setting.value,
      normalizeWatermarkSettingsStore
    );
    return watermarkSettingsMemory;
  }
  watermarkSettingsMemory = normalizeWatermarkSettingsStore({});
  return watermarkSettingsMemory;
}

/** Deduplicates one canonical watermark read while App and the settings panel mount together. */
export function loadWatermarkSettingsFromLocalApi() {
  if (!watermarkSettingsLoadPromise) {
    watermarkSettingsLoadPromise = loadWatermarkSettingsFromLocalApiInternal().finally(() => {
      watermarkSettingsLoadPromise = null;
    });
  }
  return watermarkSettingsLoadPromise;
}

export function getProductImageGroupLabel(label, count) {
  return count > 5 ? `${label} 显示 5/${count} 张` : `${label} ${count} 张`;
}

export function ProductReadOnlyField({ label, value, className = '' }) {
  return (
    <TextField
      size="small"
      label={label}
      value={value || '未返回'}
      className={`ozon-readonly-field ${className}`}
      InputProps={{
        readOnly: true,
        endAdornment: (
          <InputAdornment position="end">
            <Chip size="small" label="只读" />
          </InputAdornment>
        ),
      }}
    />
  );
}

export function createDashboardOperatingMatrixGroups(summary = {}) {
  return [
    {
      title: '交易',
      tone: 'primary',
      icon: <PriceCheckRounded />,
      items: [
        { label: '支付金额', value: summary.salesTotalDisplay || '¥0.00', delta: '—', trend: 'neutral' },
        { label: '净支付金额', value: summary.netSalesDisplay || '¥0.00', delta: '—', trend: 'neutral' },
        { label: '客单价', value: summary.averageOrderDisplay || '¥0.00', delta: '—', trend: 'neutral' },
      ],
    },
    {
      title: '流量',
      tone: 'success',
      icon: <PeopleAltRounded />,
      items: [
        { label: '访客数', value: '未读取', delta: '—', trend: 'neutral' },
        { label: '支付买家数', value: formatDashboardInteger(summary.salesOrderCount), delta: '—', trend: 'neutral' },
        { label: '支付转化率', value: '未读取', delta: '—', trend: 'neutral' },
      ],
    },
    {
      title: '退款',
      tone: 'warning',
      icon: <RemoveRounded />,
      items: [
        { label: '退款金额', value: summary.refundTotalDisplay || '¥0.00', delta: '—', trend: 'neutral' },
        { label: '退款率', value: summary.refundRateDisplay || '0.0%', delta: '—', trend: 'neutral' },
      ],
    },
    {
      title: '广告',
      tone: 'secondary',
      icon: <BarChartRounded />,
      items: [
        { label: '广告花费', value: '未读取', delta: '—', trend: 'neutral' },
        { label: '广告成交金额', value: '未读取', delta: '—', trend: 'neutral' },
        { label: '广告投产比', value: '未读取', delta: '—', trend: 'neutral' },
      ],
    },
  ];
}

export const emptyMarketingActivity = {
  id: '',
  title: '未读取活动',
  source: '未读取',
  sourceTone: 'default',
  count: 0,
  description: '选择店铺后读取活动。',
  available: 0,
  estimate: '-',
  sourceType: 'official',
};

export {
  emptyMarketingSummary,
  MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS,
} from '../../../entities/marketing/marketingCacheRules.jsx';
