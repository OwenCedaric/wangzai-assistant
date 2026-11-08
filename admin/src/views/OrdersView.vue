<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, RefreshRight, Search, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentsApi, ordersApi, projectsApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import OrderDetailsDrawer from '../components/commerce/OrderDetailsDrawer.vue'
import RefundOrderDialog from '../components/commerce/RefundOrderDialog.vue'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { fulfillmentLabel, paymentProviderLabel } from '../utils/commerce.js'
import { formatCentAmount, formatDateTime } from '../utils/formatters.js'

const loading = ref(false)
const detailLoading = ref(false)
const refunding = ref(false)
const queryingId = ref(null)
const deletingId = ref(null)
const orders = ref([])
const agents = ref([])
const projects = ref([])
const total = ref(0)
const query = reactive({ q: '', project_id: '', agent_id: '', status: '', payment_provider: '', page: 1, page_size: 20 })
const drawer = ref(false)
const refundDialog = ref(false)
const selectedOrder = ref(null)
const agentMap = computed(() => new Map(agents.value.map((item) => [item.id, item])))

async function loadOrders() {
  loading.value = true
  try { const result = await ordersApi.list(query); orders.value = result.items; total.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '在线订单加载失败')) } finally { loading.value = false }
}
async function loadOptions() {
  try {
    const [agentResult, projectResult] = await Promise.all([
      agentsApi.list({ page: 1, page_size: 100 }), projectsApi.list({ page: 1, page_size: 100 }),
    ])
    agents.value = agentResult.items
    projects.value = projectResult.items
  } catch (error) { ElMessage.error(getApiError(error, '订单筛选项加载失败')) }
}
function search() { query.page = 1; loadOrders() }
function reset() {
  Object.assign(query, { q: '', project_id: '', agent_id: '', status: '', payment_provider: '', page: 1 })
  loadOrders()
}
async function openDetails(order) {
  selectedOrder.value = order
  drawer.value = true
  detailLoading.value = true
  try { selectedOrder.value = await ordersApi.get(order.id) }
  catch (error) { ElMessage.error(getApiError(error, '订单详情加载失败')) } finally { detailLoading.value = false }
}
async function queryPayment(order = selectedOrder.value) {
  if (!order?.id) return
  queryingId.value = order.id
  try {
    const latest = await ordersApi.queryPayment(order.id)
    if (selectedOrder.value?.id === order.id) selectedOrder.value = latest
    ElMessage.success('已向支付平台主动查单')
    await loadOrders()
  } catch (error) { ElMessage.error(getApiError(error, '主动查单失败')) } finally { queryingId.value = null }
}
function openRefund(order = selectedOrder.value) {
  if (!order) return
  selectedOrder.value = order
  refundDialog.value = true
}
async function submitRefund(payload) {
  if (!selectedOrder.value?.id) return
  refunding.value = true
  try {
    const orderId = selectedOrder.value.id
    await ordersApi.refund(orderId, payload)
    selectedOrder.value = await ordersApi.get(orderId)
    refundDialog.value = false
    ElMessage.success('退款请求已提交，请关注支付平台最终状态')
    await loadOrders()
  } catch (error) { ElMessage.error(getApiError(error, '退款申请失败')) } finally { refunding.value = false }
}
async function removeOrder(order) {
  try {
    await ElMessageBox.confirm(
      `永久删除订单“${order.order_no}”及支付、退款、履约和佣金记录？已经到账的积分余额不会被反向修改。`,
      '永久删除订单',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    deletingId.value = order.id
    await ordersApi.remove(order.id)
    if (selectedOrder.value?.id === order.id) drawer.value = false
    ElMessage.success('订单及关联记录已删除')
    await loadOrders()
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '订单删除失败'))
  } finally { deletingId.value = null }
}
onMounted(() => Promise.all([loadOrders(), loadOptions()]))
</script>

<template>
  <div class="page-stack">
    <page-header title="在线订单" description="统一查看桌面端套餐购买、支付确认、卡密履约与退款状态">
      <template #actions><el-button :icon="RefreshRight" :loading="loading" @click="loadOrders">刷新订单</el-button></template>
    </page-header>
    <el-card shadow="never" class="surface-card">
      <div class="toolbar order-toolbar">
        <div class="toolbar__filters">
          <el-input v-model="query.q" clearable :prefix-icon="Search" placeholder="订单号或注册邮箱" style="width:245px" @keyup.enter="search" @clear="search" />
          <el-select v-model="query.status" clearable placeholder="全部订单状态" style="width:150px" @change="search"><el-option label="待支付" value="pending" /><el-option label="支付中" value="paying" /><el-option label="已支付" value="paid" /><el-option label="已履约" value="fulfilled" /><el-option label="退款中" value="refunding" /><el-option label="已退款" value="refunded" /><el-option label="已关闭" value="closed" /></el-select>
          <el-select v-model="query.payment_provider" clearable placeholder="全部支付渠道" style="width:150px" @change="search"><el-option label="微信支付" value="wechat" /><el-option label="支付宝" value="alipay" /><el-option label="开发模拟支付" value="development" /></el-select>
          <el-select v-model="query.agent_id" clearable filterable placeholder="全部代理" style="width:170px" @change="search"><el-option v-for="agent in agents" :key="agent.id" :label="agent.name" :value="agent.id" /></el-select>
          <el-select v-model="query.project_id" clearable filterable placeholder="全部项目" style="width:170px" @change="search"><el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" /></el-select>
          <el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="orders" stripe>
        <el-table-column label="订单" min-width="200"><template #default="{ row }"><div class="order-cell"><strong class="mono">{{ row.order_no }}</strong><span>{{ formatDateTime(row.created_at) }}</span></div></template></el-table-column>
        <el-table-column label="套餐" min-width="160"><template #default="{ row }">{{ row.plan_name_snapshot || `套餐 #${row.plan_id}` }}</template></el-table-column>
        <el-table-column label="金额" width="120"><template #default="{ row }"><strong>{{ formatCentAmount(row.amount_cent, row.currency) }}</strong></template></el-table-column>
        <el-table-column label="支付渠道" width="115"><template #default="{ row }">{{ paymentProviderLabel(row.payment_provider) }}</template></el-table-column>
        <el-table-column label="代理渠道" min-width="140"><template #default="{ row }">{{ row.agent_id ? (agentMap.get(row.agent_id)?.name || `代理 #${row.agent_id}`) : '自然注册' }}<br /><span v-if="row.channel_id" class="muted">渠道 #{{ row.channel_id }}</span></template></el-table-column>
        <el-table-column label="支付状态" width="100"><template #default="{ row }"><status-badge :status="row.status" context="order" /></template></el-table-column>
        <el-table-column label="履约" width="100"><template #default="{ row }"><span :class="{ 'fulfillment-ok': fulfillmentLabel(row) === '已履约' }">{{ fulfillmentLabel(row) }}</span></template></el-table-column>
        <el-table-column label="操作" width="282" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="View" @click="openDetails(row)">详情</el-button><el-button text type="primary" :icon="RefreshRight" :loading="queryingId === row.id" @click="queryPayment(row)">查单</el-button><el-button text type="danger" :icon="Delete" :loading="deletingId === row.id" @click="removeOrder(row)">删除</el-button></div></template></el-table-column>
        <template #empty><el-empty description="暂无在线订单" /></template>
      </el-table>
      <div class="table-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.page_size" background layout="total, sizes, prev, pager, next" :total="total" @change="loadOrders" /></div>
    </el-card>
    <order-details-drawer v-model="drawer" :order="selectedOrder" :loading="detailLoading" :querying="queryingId === selectedOrder?.id" @query="queryPayment()" @refund="openRefund()" />
    <refund-order-dialog v-model="refundDialog" :order="selectedOrder" :submitting="refunding" @submit="submitRefund" />
  </div>
</template>

<style scoped>
.order-toolbar{margin-bottom:18px}.order-cell{display:flex;flex-direction:column;gap:5px}.order-cell span{color:var(--lc-muted);font-size:11px}.fulfillment-ok{color:#168766;font-weight:600}
</style>
