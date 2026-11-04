export const PRODUCT_WRITE_STAGE = Object.freeze({
  WRITE_GUARD_ONLY: 'write_guard_only',
  LOCAL_ONLY: 'local_only',
  BLOCKED: 'blocked',
});

const PRODUCT_FIELD_WRITE_POLICY = Object.freeze({
  name: {
    field: 'name',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '商品名称可进入 Ozon 商品资料写入安全门；确认后提交 Ozon，回读并合并 SQLite 前只显示处理中。',
  },
  weight: {
    field: 'weight',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '重量可随商品资料进入写入安全门；真实回写 Ozon 需单独确认。',
  },
  length: {
    field: 'length',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '长度可随商品资料进入写入安全门；真实回写 Ozon 需单独确认。',
  },
  width: {
    field: 'width',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '宽度可随商品资料进入写入安全门；真实回写 Ozon 需单独确认。',
  },
  height: {
    field: 'height',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '高度可随商品资料进入写入安全门；真实回写 Ozon 需单独确认。',
  },
  images: {
    field: 'images',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '远程图片 URL 可进入商品资料写入安全门；本地上传图片仍阻断。',
  },
  price: {
    field: 'price',
    endpointKey: 'products.updatePrices',
    action: 'product.updatePrice',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '价格可进入价格写入安全门；确认后提交 Ozon，回读并合并 SQLite 前只显示处理中。',
  },
  oldPrice: {
    field: 'oldPrice',
    endpointKey: 'products.updatePrices',
    action: 'product.updatePrice',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '原价可进入价格写入安全门；确认后提交 Ozon，回读并合并 SQLite 前只显示处理中。',
  },
  stock: {
    field: 'stock',
    endpointKey: 'products.updateStocks',
    action: 'product.updateStock',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '库存可进入库存写入安全门；确认后提交 Ozon，回读并合并 SQLite 前只显示处理中。',
  },
  materialSource: {
    field: 'materialSource',
    endpointKey: '',
    action: 'product.materialSourceLocal',
    stage: PRODUCT_WRITE_STAGE.LOCAL_ONLY,
    label: '本地来源',
    note: '材积来源本身只保存到 SQLite；重量尺寸是否回写 Ozon 由商品资料写入安全门控制。',
  },
  attribute: {
    field: 'attribute',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: 'Ozon 属性可进入商品资料写入安全门；确认后提交 Ozon，回读并合并 SQLite 前只显示处理中。',
  },
  detailImages: {
    field: 'detailImages',
    endpointKey: 'products.import',
    action: 'product.updateInfo',
    stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    label: '安全门预览',
    note: '详情图按 Ozon Rich Content 属性写入；提交前刷新 OSS 签名，Ozon 回读完整匹配后才标记完成。',
  },
});

export function getProductWriteFieldPolicy(field = '') {
  if (String(field).startsWith('attribute:')) return PRODUCT_FIELD_WRITE_POLICY.attribute;
  return PRODUCT_FIELD_WRITE_POLICY[field] || {
    field,
    endpointKey: '',
    action: '',
    stage: PRODUCT_WRITE_STAGE.BLOCKED,
    label: '未接入',
    note: '该字段尚未登记商品写入策略。',
  };
}

export function isProductFieldAllowedInWriteGuard(field = '') {
  return getProductWriteFieldPolicy(field).stage === PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY;
}

export function listProductWriteFieldPolicies() {
  return Object.values(PRODUCT_FIELD_WRITE_POLICY);
}
