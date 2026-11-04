import AdsClickRounded from '@mui/icons-material/AdsClickRounded';
import AssessmentRounded from '@mui/icons-material/AssessmentRounded';
import CategoryRounded from '@mui/icons-material/CategoryRounded';
import CurrencyYenRounded from '@mui/icons-material/CurrencyYenRounded';
import DashboardRounded from '@mui/icons-material/DashboardRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import LocalOfferRounded from '@mui/icons-material/LocalOfferRounded';
import ManageSearchRounded from '@mui/icons-material/ManageSearchRounded';
import QueryStatsRounded from '@mui/icons-material/QueryStatsRounded';
import ReplayRounded from '@mui/icons-material/ReplayRounded';

export const dataAnalysisModuleCatalog = [
  { id: 'overview', label: '经营总览', shortLabel: '总览', icon: DashboardRounded },
  { id: 'sales', label: '销售分析', shortLabel: '销售', icon: AssessmentRounded },
  { id: 'products', label: '商品分析', shortLabel: '商品', icon: CategoryRounded },
  { id: 'traffic', label: '流量转化', shortLabel: '流量', icon: QueryStatsRounded },
  { id: 'advertising', label: '广告分析', shortLabel: '广告', icon: AdsClickRounded },
  { id: 'profit', label: '利润费用', shortLabel: '利润', icon: CurrencyYenRounded },
  { id: 'inventory', label: '库存分析', shortLabel: '库存', icon: Inventory2Rounded },
  { id: 'after-sales', label: '售后分析', shortLabel: '售后', icon: ReplayRounded },
  { id: 'marketing', label: '促销分析', shortLabel: '促销', icon: LocalOfferRounded },
  { id: 'market', label: '市场机会', shortLabel: '市场', icon: ManageSearchRounded },
];

export const dataAnalysisDatePresets = [
  { id: 'today', label: '今天', days: 1 },
  { id: '7d', label: '近7天', days: 7 },
  { id: '30d', label: '近30天', days: 30 },
  { id: '90d', label: '近90天', days: 90 },
  { id: 'custom', label: '自定义', days: null },
];

export const dataAnalysisGuardRails = [
  '所有经营指标只读取平台官方缓存、广告接口实时结果或人工确认数据。',
  '缺失、币种未确认或权限未开通的数据保持空值并展示来源状态，不用 0 或估算值冒充。',
  '前端只请求本地数据服务；分析结果不覆盖商品、订单、售后、营销和利润业务表。',
  '订单原始响应中的买家姓名、电话、邮箱和地址不会进入分析响应。',
];

export const sourceStatusMeta = Object.freeze({
  ready: { label: '本地数据已就绪', color: 'success' },
  empty: { label: '缓存为空', color: 'default' },
  live_ready: { label: '实时授权可用', color: 'primary' },
  authorization_required: { label: '需要授权', color: 'warning' },
  not_synced: { label: '尚未同步', color: 'warning' },
  not_in_sqlite: { label: '未进入本地分析库', color: 'warning' },
});
