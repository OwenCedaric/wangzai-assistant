const MATERIAL_SOURCE_META = Object.freeze({
  'cross-border-bus': { label: '跨境巴士实测', rank: 400 },
  cross_border_bus: { label: '跨境巴士实测', rank: 400 },
  crossBorderBus: { label: '跨境巴士实测', rank: 400 },
  'manual-confirmed': { label: '人工确认', rank: 320 },
  manual_confirmed: { label: '人工确认', rank: 320 },
  'supplier-confirmed': { label: '上游提供', rank: 300 },
  supplier_confirmed: { label: '上游提供', rank: 300 },
  supplier: { label: '上游提供', rank: 300 },
  'ozon-product-save-readback': { label: 'Ozon 保存后回读', rank: 220 },
  'ozon-product-list-read': { label: 'Ozon 列表读取', rank: 210 },
  'ozon-readback': { label: 'Ozon 回读', rank: 200 },
  'ozon-initial-read': { label: 'Ozon 返回', rank: 180 },
  missing: { label: '缺失', rank: 0 },
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeSource(value) {
  const source = normalizeText(value) || 'missing';
  if (source === 'cross_border_bus' || source === 'crossBorderBus') return 'cross-border-bus';
  if (source === 'manual_confirmed') return 'manual-confirmed';
  if (source === 'supplier_confirmed' || source === 'supplier') return 'supplier-confirmed';
  return source;
}

function getSourceMeta(source) {
  const normalized = normalizeSource(source);
  return MATERIAL_SOURCE_META[normalized] || { label: normalized, rank: 0 };
}

function toNumberText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return normalizeText(value);
  return String(number);
}

function compactMaterial(item = {}) {
  const source = normalizeSource(item.source || item.materialSource);
  const meta = getSourceMeta(source);
  return {
    source,
    label: item.label || meta.label,
    sourceRank: Number(item.sourceRank ?? item.source_rank ?? meta.rank) || 0,
    weight: toNumberText(item.weight ?? item.weightKg ?? item.weight_kg),
    length: toNumberText(item.length ?? item.depthCm ?? item.depth_cm ?? item.depth),
    width: toNumberText(item.width ?? item.widthCm ?? item.width_cm),
    height: toNumberText(item.height ?? item.heightCm ?? item.height_cm),
    isConfirmed: Boolean(item.isConfirmed ?? item.is_confirmed),
    updatedAt: normalizeText(item.updatedAt ?? item.updated_at),
    ozonSyncStatus: normalizeText(item.ozonSyncStatus ?? item.ozon_sync_status),
  };
}

function hasCompleteMaterial(item = {}) {
  return ['weight', 'length', 'width', 'height'].every((field) => normalizeText(item[field]) !== '');
}

export function buildProductMaterialCandidates(product = {}, form = {}) {
  const candidates = [];
  const fromApi = Array.isArray(product.materialCandidates)
    ? product.materialCandidates
    : Array.isArray(product.materialProfiles)
      ? product.materialProfiles
      : [];
  candidates.push(...fromApi.map(compactMaterial));
  if (product.materialProfile) candidates.push(compactMaterial(product.materialProfile));
  const ozonCandidate = compactMaterial({
    source: 'ozon-initial-read',
    weight: product.weight,
    length: product.length,
    width: product.width,
    height: product.height,
    updatedAt: product.updatedAt,
  });
  if (hasCompleteMaterial(ozonCandidate)) candidates.push(ozonCandidate);

  const formCandidate = compactMaterial({
    source: form.materialSource,
    label: '当前编辑值',
    weight: form.weight,
    length: form.length,
    width: form.width,
    height: form.height,
    isConfirmed: normalizeSource(form.materialSource) === 'supplier-confirmed',
  });
  if (hasCompleteMaterial(formCandidate) && normalizeSource(form.materialSource) !== 'missing') {
    candidates.push(formCandidate);
  }

  const seen = new Set();
  return candidates
    .filter(hasCompleteMaterial)
    .sort((left, right) => (Number(right.sourceRank) || 0) - (Number(left.sourceRank) || 0))
    .filter((item) => {
      const key = item.source;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sameValue(left, right) {
  return normalizeText(left) === normalizeText(right);
}

function addChange(changes, field, label, before, after, target) {
  if (sameValue(before, after)) return;
  const policy = getProductWriteFieldPolicy(field);
  changes.push({
    field,
    label,
    before: normalizeText(before) || '空',
    after: normalizeText(after) || '空',
    target,
    policy,
    writeStage: policy.stage,
    writeLabel: policy.label,
  });
}

function imageList(value) {
  return (Array.isArray(value) ? value : []).map((item) => normalizeText(item?.url ?? item)).filter(Boolean);
}

export function buildProductCardDiff(product = {}, form = {}) {
  const changes = [];
  addChange(changes, 'name', '商品名称', product.name, form.name, 'product.updateInfo');
  addChange(changes, 'weight', '产品重量 kg', product.weight, form.weight, 'product.updateInfo');
  addChange(changes, 'length', '产品长 cm', product.length, form.length, 'product.updateInfo');
  addChange(changes, 'width', '产品宽 cm', product.width, form.width, 'product.updateInfo');
  addChange(changes, 'height', '产品高 cm', product.height, form.height, 'product.updateInfo');
  addChange(changes, 'materialSource', '材积来源', normalizeSource(product.materialSource || product.materialProfile?.source), normalizeSource(form.materialSource), 'product.updateInfo');
  addChange(changes, 'price', '价格', product.priceValue ?? product.price, form.price, 'product.updatePrice');
  addChange(changes, 'oldPrice', '原价', product.oldPriceValue ?? product.oldPrice, form.oldPrice, 'product.updatePrice');
  addChange(changes, 'stock', '库存', product.stock, form.stock, 'product.updateStock');

  const beforeImages = imageList(product.images);
  const afterImages = imageList(form.images);
  if (beforeImages.join('|') !== afterImages.join('|')) {
    const policy = getProductWriteFieldPolicy('images');
    changes.push({
      field: 'images',
      label: '主图/轮播图',
      before: `${beforeImages.length} 张`,
      after: `${afterImages.length} 张`,
      target: 'product.updateInfo',
      policy,
      writeStage: policy.stage,
      writeLabel: policy.label,
    });
  }

  const changedAttributes = Array.isArray(form.attributeRows)
    ? form.attributeRows.filter((row) => !sameValue(row.value, form.attributeValues?.[row.id]))
    : [];
  changedAttributes.forEach((row) => {
    const field = `attribute:${row.id}`;
    const policy = getProductWriteFieldPolicy(field);
    changes.push({
      field,
      label: row.label || `属性 ${row.id}`,
      before: normalizeText(row.value) || '空',
      after: normalizeText(form.attributeValues?.[row.id]) || '空',
      target: 'product.updateInfo',
      policy,
      writeStage: policy.stage,
      writeLabel: policy.label,
    });
  });

  const targets = new Set(changes.map((item) => item.target));
  const summaryLabels = [
    targets.has('product.updateInfo') ? '商品资料/图片/属性' : '',
    targets.has('product.updatePrice') ? '价格' : '',
    targets.has('product.updateStock') ? '库存' : '',
  ].filter(Boolean);

  return {
    changed: changes.length > 0,
    changes,
    summaryLabels,
    targets: [...targets],
  };
}
import { getProductWriteFieldPolicy } from './productWritePolicy';
