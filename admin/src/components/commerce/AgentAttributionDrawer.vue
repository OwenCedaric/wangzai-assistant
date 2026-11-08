<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { agentsApi, ordersApi } from '../../api/admin.js'
import { getApiError } from '../../api/response.js'
import { formatCentAmount, formatDateTime } from '../../utils/formatters.js'
import { maskedPhone } from '../../utils/commerce.js'
import { userDisplayName } from '../../utils/userIdentity.js'
import StatusBadge from '../common/StatusBadge.vue'

const props = defineProps({ modelValue: { type: Boolean, default: false }, agent: { type: Object, default: null } })
const emit = defineEmits(['update:modelValue'])
const activeTab = ref('users')
const loadingUsers = ref(false)
const loadingOrders = ref(false)
const users = ref([])
const orders = ref([])
const userTotal = ref(0)
const orderTotal = ref(0)
const userQuery = reactive({ q: '', page: 1, page_size: 10 })
const orderQuery = reactive({ page: 1, page_size: 10 })
const drawerSize = computed(() => window.innerWidth < 760 ? '94%' : '760px')

async function loadUsers() {
  if (!props.agent?.id) return
  loadingUsers.value = true
  try {
    const result = await agentsApi.users(props.agent.id, userQuery)
    users.value = result.items
    userTotal.value = result.total
  } catch (error) { ElMessage.error(getApiError(error, '归属用户加载失败')) } finally { loadingUsers.value = false }
}
async function loadOrders() {
  if (!props.agent?.id) return
  loadingOrders.value = true
  try {
    const result = await ordersApi.list({ agent_id: props.agent.id, ...orderQuery })
    orders.value = result.items
    orderTotal.value = result.total
  } catch (error) { ElMessage.error(getApiError(error, '代理订单加载失败')) } finally { loadingOrders.value = false }
}
function searchUsers() { userQuery.page = 1; loadUsers() }
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  activeTab.value = 'users'
  userQuery.q = ''
  userQuery.page = 1
  orderQuery.page = 1
  Promise.all([loadUsers(), loadOrders()])
})
</script>

<template>
  <el-drawer :model-value="modelValue" :size="drawerSize" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <template #header><div class="drawer-title"><strong>{{ agent?.name || '代理详情' }}</strong><span class="mono">{{ agent?.code }}</span></div></template>
    <div class="summary-strip"><div><span>归属用户</span><strong>{{ agent?.user_count ?? userTotal }}</strong></div><div><span>累计订单</span><strong>{{ agent?.order_count ?? orderTotal }}</strong></div></div>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="归属用户" name="users">
        <div class="search-row"><el-input v-model="userQuery.q" clearable placeholder="搜索注册邮箱或手机号" @keyup.enter="searchUsers" @clear="searchUsers" /><el-button type="primary" @click="searchUsers">查询</el-button></div>
        <el-table v-loading="loadingUsers" :data="users" stripe>
          <el-table-column label="用户" min-width="220"><template #default="{ row }"><strong>{{ userDisplayName(row) }}</strong><br /><span class="muted">{{ maskedPhone(row.phone_masked) }}</span></template></el-table-column>
          <el-table-column label="项目 / 渠道" min-width="160"><template #default="{ row }">{{ row.project_code || row.project_id }}<br /><span class="muted mono">{{ row.channel_code || '自然注册' }}</span></template></el-table-column>
          <el-table-column label="锁定时间" width="160"><template #default="{ row }">{{ formatDateTime(row.locked_at) }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
          <template #empty><el-empty description="暂无归属用户" /></template>
        </el-table>
        <div class="table-pagination"><el-pagination v-model:current-page="userQuery.page" background small layout="total, prev, pager, next" :total="userTotal" :page-size="userQuery.page_size" @change="loadUsers" /></div>
      </el-tab-pane>
      <el-tab-pane label="代理订单" name="orders">
        <el-table v-loading="loadingOrders" :data="orders" stripe>
          <el-table-column prop="order_no" label="订单号" min-width="180"><template #default="{ row }"><span class="mono">{{ row.order_no }}</span></template></el-table-column>
          <el-table-column label="套餐" min-width="130"><template #default="{ row }">{{ row.plan_name_snapshot || row.plan_id }}</template></el-table-column>
          <el-table-column label="金额" width="110"><template #default="{ row }">{{ formatCentAmount(row.amount_cent, row.currency) }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" context="order" /></template></el-table-column>
          <el-table-column label="创建时间" width="160"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column>
          <template #empty><el-empty description="暂无代理订单" /></template>
        </el-table>
        <div class="table-pagination"><el-pagination v-model:current-page="orderQuery.page" background small layout="total, prev, pager, next" :total="orderTotal" :page-size="orderQuery.page_size" @change="loadOrders" /></div>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.drawer-title{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:10px}.drawer-title span{min-width:0;color:var(--lc-muted);font-size:12px;overflow-wrap:anywhere}.summary-strip{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}.summary-strip>div{min-width:0;padding:14px;border-radius:10px;background:#f5f7fb}.summary-strip span{display:block;color:var(--lc-muted);font-size:12px}.summary-strip strong{display:block;margin-top:5px;font-size:22px}.search-row{display:flex;min-width:0;flex-wrap:wrap;gap:10px;margin-bottom:14px}.search-row .el-input{min-width:220px;max-width:300px;flex:1 1 220px}.search-row .el-button{flex:0 0 auto}@media(max-width:520px){.summary-strip{grid-template-columns:1fr}.search-row .el-input{width:100%;min-width:0;max-width:none}.search-row .el-button{width:100%}}
</style>
