import {
  Coin, CollectionTag, Connection, CreditCard, DataAnalysis, Files, House, Key, Money, Monitor,
  Picture, Setting, Shop, ShoppingCart, UserFilled,
} from '@element-plus/icons-vue'

export const navigation = [
  { path: '/dashboard', label: '工作台', icon: House },
  { path: '/projects', label: '项目管理', icon: Files },
  { path: '/plans', label: '套餐与权限', icon: CollectionTag },
  { path: '/users-licenses', label: '用户与授权', icon: UserFilled },
  { path: '/card-batches', label: '卡密管理', icon: Key },
  { path: '/agents-channels', label: '代理与渠道', icon: Connection },
  { path: '/orders', label: '在线订单', icon: ShoppingCart },
  { path: '/commissions', label: '佣金管理', icon: Money },
  { path: '/points', label: '积分管理', icon: Coin },
  { path: '/api-pool', label: 'API 池', icon: Connection },
  { path: '/oss-management', label: 'OSS 管理', icon: Picture },
  { path: '/payment-status', label: '支付配置', icon: Setting },
  { path: '/devices', label: '设备管理', icon: Monitor },
  { path: '/shops', label: '店铺管理', icon: Shop },
  { path: '/usage-logs', label: '使用日志', icon: DataAnalysis },
]

export const appMarkIcon = CreditCard
