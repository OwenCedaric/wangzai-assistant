export const productStatusTabs = [
  { label: '全部商品', shortLabel: '所有', visibility: 'ALL', tone: 'primary' },
  { label: '出售中', shortLabel: '销售中', visibility: 'IN_SALE', tone: 'success' },
  { label: '待销售', shortLabel: '待销售', visibility: 'TO_SUPPLY', tone: 'warning' },
  { label: '错误品', shortLabel: '错误', visibility: 'STATE_FAILED', tone: 'error' },
  { label: '待修改', shortLabel: '待修改', visibility: 'VALIDATION_STATE_FAIL', tone: 'warning' },
  { label: '违规品', shortLabel: '违规商品', visibility: 'REMOVED_FROM_SALE', tone: 'error' },
  { label: '已下架', shortLabel: '下架', visibility: 'ARCHIVED', tone: 'default' },
];

export const productStatusToneMap = Object.fromEntries(productStatusTabs.map((tab) => [tab.label, tab.tone]));

export const ozonProductVisibilityStatusMap = Object.fromEntries(
  productStatusTabs.filter((tab) => tab.visibility !== 'ALL').map((tab) => [tab.visibility, tab.label])
);

export function normalizeProductStatusLabel(status) {
  if (status === '全部商品') return '';
  if (status === '销售中') return '出售中';
  if (status === '准备销售' || status === '已售罄') return '待销售';
  if (status === '错误') return '错误品';
  if (status === '商品已下架') return '违规品';
  if (status === '档案') return '已下架';
  return status;
}
