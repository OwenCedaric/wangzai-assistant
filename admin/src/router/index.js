import { createRouter, createWebHistory } from 'vue-router'
import { hasAuthSession } from '../auth/authSession.js'

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { title: '登录' } },
  {
    path: '/',
    component: () => import('../layouts/AppShell.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '工作台' } },
      { path: 'projects', component: () => import('../views/ProjectsView.vue'), meta: { title: '项目管理' } },
      { path: 'plans', component: () => import('../views/PlansView.vue'), meta: { title: '套餐与权限' } },
      { path: 'users-licenses', component: () => import('../views/UsersLicensesView.vue'), meta: { title: '用户与授权' } },
      { path: 'card-batches', component: () => import('../views/CardBatchesView.vue'), meta: { title: '卡密管理' } },
      { path: 'agents-channels', component: () => import('../views/AgentsChannelsView.vue'), meta: { title: '代理与渠道' } },
      { path: 'orders', component: () => import('../views/OrdersView.vue'), meta: { title: '在线订单' } },
      { path: 'commissions', component: () => import('../views/CommissionsView.vue'), meta: { title: '佣金管理' } },
      { path: 'points', component: () => import('../views/PointsView.vue'), meta: { title: '积分管理' } },
      { path: 'api-pool', component: () => import('../views/ApiPoolView.vue'), meta: { title: 'API 池' } },
      { path: 'oss-management', component: () => import('../views/OssManagementView.vue'), meta: { title: 'OSS 管理' } },
      { path: 'payment-status', component: () => import('../views/PaymentStatusView.vue'), meta: { title: '支付配置' } },
      { path: 'devices', component: () => import('../views/DevicesView.vue'), meta: { title: '设备管理' } },
      { path: 'shops', component: () => import('../views/ShopsView.vue'), meta: { title: '店铺管理' } },
      { path: 'usage-logs', component: () => import('../views/UsageLogsView.vue'), meta: { title: '使用日志' } },
    ],
  },
  { path: '/:pathMatch(.*)*', component: () => import('../views/NotFoundView.vue'), meta: { title: '页面不存在' } },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !hasAuthSession()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && hasAuthSession()) return '/dashboard'
  return true
})

router.afterEach((to) => {
  document.title = `${to.meta.title || '管理后台'} · License Center`
})

export default router
