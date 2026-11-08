<script setup>
import { computed, onMounted, ref } from 'vue'
import { RefreshRight } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { dashboardApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import MetricCard from '../components/common/MetricCard.vue'
import PageHeader from '../components/common/PageHeader.vue'
import { formatNumber } from '../utils/formatters.js'

const loading = ref(false)
const data = ref({})

function pick(...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((current, part) => current?.[part], data.value)
    if (value !== undefined && value !== null) return Number(value) || 0
  }
  return 0
}

const userMetrics = computed(() => [
  { label: '用户总数', value: formatNumber(pick('users_total', 'users.total', 'total_users', 'user_total')), note: '平台累计用户', tone: 'blue' },
  { label: '付费用户', value: formatNumber(pick('users.paid', 'paid_users')), note: '当前有效授权', tone: 'green' },
  { label: '今日活跃', value: formatNumber(pick('users.active_today', 'active_users_today', 'today_active_users')), note: '今日发生使用行为', tone: 'purple' },
  { label: '当前在线', value: formatNumber(pick('users.online', 'online_users')), note: '近期心跳在线', tone: 'orange' },
  { label: '已到期授权', value: formatNumber(pick('expired_licenses', 'users.expired', 'expiring_licenses')), note: '当前已过期 License', tone: 'red' },
])

const shops = computed(() => [
  { label: 'Ozon', value: pick('shops_by_platform.ozon', 'shops.ozon', 'shop_counts.ozon'), color: '#315efb' },
  { label: '淘宝', value: pick('shops_by_platform.taobao', 'shops.taobao', 'shop_counts.taobao'), color: '#20a67a' },
  { label: '天猫', value: pick('shops_by_platform.tmall', 'shops.tmall', 'shop_counts.tmall'), color: '#f39b32' },
  { label: '拼多多', value: pick('shops_by_platform.pinduoduo', 'shops.pinduoduo', 'shop_counts.pinduoduo'), color: '#7c5ce7' },
])
const maxShopCount = computed(() => Math.max(1, ...shops.value.map((item) => item.value)))

const usage = computed(() => ({
  launches: pick('launches_today', 'usage.launches_today', 'today_launches'),
  calls: pick('feature_calls_today', 'usage.feature_calls_today', 'feature_calls'),
  projects: pick('projects.active', 'active_projects', 'project_count'),
  licenses: pick('licenses.active', 'active_licenses', 'license_count'),
}))

async function loadDashboard() {
  loading.value = true
  try {
    data.value = await dashboardApi.get() || {}
  } catch (error) {
    ElMessage.error(getApiError(error, '工作台数据加载失败'))
  } finally {
    loading.value = false
  }
}

onMounted(loadDashboard)
</script>

<template>
  <div v-loading="loading" class="page-stack dashboard">
    <page-header title="工作台" description="授权业务的核心指标与运行概况">
      <template #actions><el-button :icon="RefreshRight" @click="loadDashboard">刷新数据</el-button></template>
    </page-header>

    <section class="metric-grid">
      <metric-card v-for="item in userMetrics" :key="item.label" v-bind="item" />
    </section>

    <section class="dashboard-grid">
      <el-card shadow="never" class="surface-card shops-card">
        <template #header><div class="card-heading"><div><strong>绑定店铺</strong><span>按平台统计已绑定店铺</span></div><b>{{ formatNumber(shops.reduce((sum, item) => sum + item.value, 0)) }}</b></div></template>
        <div v-for="shop in shops" :key="shop.label" class="shop-row">
          <div class="shop-row__meta"><span>{{ shop.label }}</span><strong>{{ formatNumber(shop.value) }}</strong></div>
          <div class="shop-row__track"><span :style="{ width: `${Math.max(3, shop.value / maxShopCount * 100)}%`, background: shop.color }" /></div>
        </div>
      </el-card>

      <el-card shadow="never" class="surface-card usage-card">
        <template #header><div class="card-heading"><div><strong>今日软件使用</strong><span>客户端启动与服务端功能调用</span></div></div></template>
        <div class="usage-highlight">
          <div><span>今日启动次数</span><strong>{{ formatNumber(usage.launches) }}</strong></div>
          <div><span>功能调用次数</span><strong>{{ formatNumber(usage.calls) }}</strong></div>
        </div>
        <div class="usage-secondary">
          <div><span>启用项目</span><b>{{ formatNumber(usage.projects) }}</b></div>
          <div><span>有效授权</span><b>{{ formatNumber(usage.licenses) }}</b></div>
        </div>
      </el-card>
    </section>

    <el-card shadow="never" class="surface-card quick-card">
      <div class="quick-card__copy"><strong>快速开始</strong><span>先创建软件项目与产品版本，再配置套餐权限并生成卡密。</span></div>
      <div class="quick-card__actions">
        <el-button type="primary" @click="$router.push('/projects')">接入新项目</el-button>
        <el-button @click="$router.push('/plans')">配置套餐</el-button>
        <el-button @click="$router.push('/card-batches')">生成卡密</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.dashboard-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 18px; }.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.card-heading > div { display: flex; flex-direction: column; gap: 5px; }.card-heading strong { font-size: 15px; }.card-heading span { color: var(--lc-muted); font-size: 12px; }.card-heading b { font-size: 24px; }
.shops-card :deep(.el-card__body) { display: grid; gap: 19px; }.shop-row__meta { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }.shop-row__meta strong { font-size: 14px; }.shop-row__track { height: 8px; overflow: hidden; border-radius: 8px; background: #eef1f6; }.shop-row__track span { display: block; height: 100%; border-radius: inherit; transition: width .3s; }
.usage-highlight { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.usage-highlight > div { padding: 18px; border-radius: 12px; background: #f5f7fb; }.usage-highlight span, .usage-secondary span { display: block; color: var(--lc-muted); font-size: 12px; }.usage-highlight strong { display: block; margin-top: 12px; font-size: 28px; }.usage-secondary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }.usage-secondary > div { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border: 1px solid var(--lc-border); border-radius: 10px; }.usage-secondary b { font-size: 17px; }
.quick-card :deep(.el-card__body) { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.quick-card__copy { display: flex; flex-direction: column; gap: 6px; }.quick-card__copy span { color: var(--lc-muted); font-size: 13px; }.quick-card__actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 1180px) { .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 820px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.dashboard-grid { grid-template-columns: 1fr; }.quick-card :deep(.el-card__body) { align-items: flex-start; flex-direction: column; } }
@media (max-width: 480px) { .metric-grid { grid-template-columns: 1fr; }.usage-highlight { grid-template-columns: 1fr; } }
</style>
