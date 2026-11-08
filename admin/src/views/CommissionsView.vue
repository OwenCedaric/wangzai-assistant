<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, RefreshRight, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  agentsApi, commissionRulesApi, commissionsApi, plansApi, productsApi, projectsApi,
} from '../api/admin.js'
import { getApiError } from '../api/response.js'
import CommissionRuleDialog from '../components/commerce/CommissionRuleDialog.vue'
import MetricCard from '../components/common/MetricCard.vue'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { formatCentAmount, formatDateTime, formatRateBps } from '../utils/formatters.js'

const loading = ref(false)
const commissions = ref([])
const agents = ref([])
const projects = ref([])
const products = ref([])
const plans = ref([])
const commissionRules = ref([])
const dashboard = ref({})
const total = ref(0)
const ruleTotal = ref(0)
const ruleLoading = ref(false)
const ruleSubmitting = ref(false)
const ruleDialog = ref(false)
const editingRule = ref(null)
const query = reactive({ agent_id: '', order_id: '', status: '', page: 1, page_size: 20 })
const ruleQuery = reactive({ agent_id: '', page: 1, page_size: 20 })
const agentMap = computed(() => new Map(agents.value.map((item) => [item.id, item])))
const projectMap = computed(() => new Map(projects.value.map((item) => [item.id, item])))
const planMap = computed(() => new Map(plans.value.map((item) => [item.id, item])))

function centValue(...keys) {
  for (const key of keys) {
    const value = dashboard.value?.[key]
    if (value !== null && value !== undefined) return value
  }
  return 0
}
const metrics = computed(() => [
  { label: '待结算佣金', value: formatCentAmount(centValue('pending_cent', 'pending_amount_cent', 'commission_pending_cent')), note: '支付成功后进入冻结期', tone: 'orange' },
  { label: '可结算佣金', value: formatCentAmount(centValue('available_cent', 'available_amount_cent', 'commission_available_cent')), note: '已过退款观察期', tone: 'blue' },
  { label: '已结算佣金', value: formatCentAmount(centValue('settled_cent', 'settled_amount_cent', 'commission_settled_cent')), note: '历史累计结算', tone: 'green' },
  { label: '已冲销佣金', value: formatCentAmount(centValue('reversed_cent', 'reversed_amount_cent', 'commission_reversed_cent')), note: '退款产生的冲销账务', tone: 'red' },
])

async function loadCommissions() {
  loading.value = true
  try { const result = await commissionsApi.list(query); commissions.value = result.items; total.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '佣金账本加载失败')) } finally { loading.value = false }
}
async function loadDashboard() {
  try { dashboard.value = await commissionsApi.dashboard() || {} }
  catch (error) { ElMessage.error(getApiError(error, '佣金汇总加载失败')) }
}
async function loadCatalog() {
  try {
    const [agentResult, projectResult, productResult, planResult] = await Promise.all([
      agentsApi.list({ page: 1, page_size: 100 }), projectsApi.list({ page: 1, page_size: 100 }),
      productsApi.list({ page: 1, page_size: 100 }), plansApi.list({ page: 1, page_size: 100 }),
    ])
    agents.value = agentResult.items
    projects.value = projectResult.items
    products.value = productResult.items
    plans.value = planResult.items
  } catch (error) { ElMessage.error(getApiError(error, '佣金规则选项加载失败')) }
}
async function loadRules() {
  ruleLoading.value = true
  try { const result = await commissionRulesApi.list(ruleQuery); commissionRules.value = result.items; ruleTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '佣金规则加载失败')) } finally { ruleLoading.value = false }
}
function openRule(rule = null) { editingRule.value = rule; ruleDialog.value = true }
async function saveRule(payload) {
  ruleSubmitting.value = true
  try {
    if (editingRule.value) await commissionRulesApi.update(editingRule.value.id, payload)
    else await commissionRulesApi.create(payload)
    ElMessage.success(editingRule.value ? '佣金规则已更新' : '佣金规则已创建')
    ruleDialog.value = false
    await loadRules()
  } catch (error) { ElMessage.error(getApiError(error, '佣金规则保存失败')) } finally { ruleSubmitting.value = false }
}
async function removeRule(rule) {
  try {
    await ElMessageBox.confirm('删除只影响后续新订单，已有订单仍保留原佣金快照。确定删除吗？', '删除佣金规则', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await commissionRulesApi.remove(rule.id)
    ElMessage.success('佣金规则已删除')
    await loadRules()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '佣金规则删除失败')) }
}
function ruleScope(rule) {
  if (rule.plan_id) return `${projectMap.value.get(rule.project_id)?.name || `项目 #${rule.project_id}`} / ${planMap.value.get(rule.plan_id)?.name || `套餐 #${rule.plan_id}`}`
  if (rule.project_id) return projectMap.value.get(rule.project_id)?.name || `项目 #${rule.project_id}`
  return '代理全部项目'
}
function search() { query.page = 1; loadCommissions() }
function reset() { Object.assign(query, { agent_id: '', order_id: '', status: '', page: 1 }); loadCommissions() }
function filterRules() { ruleQuery.page = 1; loadRules() }
async function removeCommission(record) {
  try {
    await ElMessageBox.confirm(
      `永久删除订单 #${record.order_id} 的佣金账务记录？`,
      '永久删除佣金记录',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await commissionsApi.remove(record.id)
    ElMessage.success('佣金记录已删除')
    await Promise.all([loadCommissions(), loadDashboard()])
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '佣金记录删除失败')) }
}
function timelineValue(row) {
  if (row.status === 'settled') return row.settled_at
  if (row.status === 'reversed') return row.reversed_at
  return row.available_at || row.created_at
}
onMounted(() => Promise.all([loadCommissions(), loadDashboard(), loadCatalog(), loadRules()]))
</script>

<template>
  <div class="page-stack">
    <page-header title="佣金管理" description="订单支付后按下单时的佣金比例快照记账，退款只做冲销，不删除历史记录">
      <template #actions><el-button :icon="RefreshRight" :loading="loading" @click="Promise.all([loadCommissions(), loadDashboard()])">刷新账本</el-button></template>
    </page-header>
    <section class="metric-grid"><metric-card v-for="item in metrics" :key="item.label" v-bind="item" /></section>
    <el-card shadow="never" class="surface-card">
      <template #header><div class="rule-heading"><div><strong>佣金规则</strong><span>套餐规则 ＞ 项目规则 ＞ 代理全局规则 ＞ 代理资料中的默认比例</span></div><el-button type="primary" :icon="Plus" :disabled="!agents.length" @click="openRule()">新增规则</el-button></div></template>
      <div class="toolbar rule-toolbar"><div class="toolbar__filters"><el-select v-model="ruleQuery.agent_id" clearable filterable placeholder="全部代理" style="width:210px" @change="filterRules"><el-option v-for="agent in agents" :key="agent.id" :label="agent.name" :value="agent.id" /></el-select><el-button @click="filterRules">筛选</el-button></div></div>
      <el-table v-loading="ruleLoading" :data="commissionRules" stripe>
        <el-table-column label="代理" min-width="170"><template #default="{ row }">{{ agentMap.get(row.agent_id)?.name || `代理 #${row.agent_id}` }}</template></el-table-column>
        <el-table-column label="适用范围" min-width="230"><template #default="{ row }">{{ ruleScope(row) }}</template></el-table-column>
        <el-table-column label="佣金比例" width="110"><template #default="{ row }"><strong>{{ formatRateBps(row.rate_bps) }}</strong></template></el-table-column>
        <el-table-column label="状态" width="95"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
        <el-table-column label="更新时间" width="170"><template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template></el-table-column>
        <el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openRule(row)">编辑</el-button><el-button text type="danger" :icon="Delete" @click="removeRule(row)">删除</el-button></div></template></el-table-column>
        <template #empty><el-empty description="暂无覆盖规则，将使用代理默认佣金比例" /></template>
      </el-table>
      <div class="table-pagination"><el-pagination v-model:current-page="ruleQuery.page" v-model:page-size="ruleQuery.page_size" background layout="total, prev, pager, next" :total="ruleTotal" @change="loadRules" /></div>
    </el-card>
    <el-card shadow="never" class="surface-card">
      <el-alert title="账务记录不允许改金额" description="可以删除无用或测试账务；代理默认比例变化不会改写已有订单快照。" type="info" :closable="false" show-icon />
      <div class="toolbar commission-toolbar">
        <div class="toolbar__filters">
          <el-select v-model="query.agent_id" clearable filterable placeholder="全部代理" style="width:190px" @change="search"><el-option v-for="agent in agents" :key="agent.id" :label="agent.name" :value="agent.id" /></el-select>
          <el-input v-model="query.order_id" clearable :prefix-icon="Search" placeholder="按订单 ID 查询" style="width:180px" @keyup.enter="search" @clear="search" />
          <el-select v-model="query.status" clearable placeholder="全部状态" style="width:150px" @change="search"><el-option label="待结算" value="pending" /><el-option label="可结算" value="available" /><el-option label="已结算" value="settled" /><el-option label="已冲销" value="reversed" /></el-select>
          <el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="commissions" stripe>
        <el-table-column label="代理" min-width="160"><template #default="{ row }"><strong>{{ agentMap.get(row.agent_id)?.name || `代理 #${row.agent_id}` }}</strong><br /><span class="muted mono">{{ agentMap.get(row.agent_id)?.code || '' }}</span></template></el-table-column>
        <el-table-column label="关联订单" min-width="130"><template #default="{ row }"><span class="mono">#{{ row.order_id }}</span></template></el-table-column>
        <el-table-column label="佣金基数" width="125"><template #default="{ row }">{{ formatCentAmount(row.base_amount_cent) }}</template></el-table-column>
        <el-table-column label="比例快照" width="105"><template #default="{ row }">{{ formatRateBps(row.rate_bps) }}</template></el-table-column>
        <el-table-column label="佣金金额" width="125"><template #default="{ row }"><strong>{{ formatCentAmount(row.commission_amount_cent) }}</strong></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" context="commission" /></template></el-table-column>
        <el-table-column label="状态时间" width="170"><template #default="{ row }">{{ formatDateTime(timelineValue(row)) }}</template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button text type="danger" :icon="Delete" @click="removeCommission(row)">删除</el-button></template></el-table-column>
        <template #empty><el-empty description="暂无佣金账务" /></template>
      </el-table>
      <div class="table-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.page_size" background layout="total, sizes, prev, pager, next" :total="total" @change="loadCommissions" /></div>
    </el-card>
    <commission-rule-dialog v-model="ruleDialog" :rule="editingRule" :agents="agents" :projects="projects" :products="products" :plans="plans" :submitting="ruleSubmitting" @submit="saveRule" />
  </div>
</template>

<style scoped>
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.commission-toolbar{margin:18px 0}.rule-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.rule-heading>div{display:flex;flex-direction:column;gap:5px}.rule-heading span{color:var(--lc-muted);font-size:12px}.rule-toolbar{margin-bottom:15px}
@media(max-width:1180px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.metric-grid{grid-template-columns:1fr}}
</style>
