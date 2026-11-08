<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Key, Lock, Plus, Unlock, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { agentsApi, channelsApi, projectsApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import AgentAttributionDrawer from '../components/commerce/AgentAttributionDrawer.vue'
import AgentFormDialog from '../components/commerce/AgentFormDialog.vue'
import ChannelFormDialog from '../components/commerce/ChannelFormDialog.vue'
import DistributionTokenDialog from '../components/commerce/DistributionTokenDialog.vue'
import MetricCard from '../components/common/MetricCard.vue'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { maskedPhone } from '../utils/commerce.js'
import { formatCentAmount, formatDateTime, formatNumber, formatRateBps } from '../utils/formatters.js'

const activeTab = ref('agents')
const agentLoading = ref(false)
const channelLoading = ref(false)
const submitting = ref(false)
const agents = ref([])
const agentOptions = ref([])
const channels = ref([])
const projects = ref([])
const dashboard = ref({})
const agentTotal = ref(0)
const channelTotal = ref(0)
const agentQuery = reactive({ keyword: '', status: '', page: 1, page_size: 20 })
const channelQuery = reactive({ agent_id: '', project_id: '', status: '', page: 1, page_size: 20 })
const agentDialog = ref(false)
const channelDialog = ref(false)
const tokenDialog = ref(false)
const detailDrawer = ref(false)
const editingAgent = ref(null)
const editingChannel = ref(null)
const selectedAgent = ref(null)
const tokenChannel = ref(null)
const statusChangingId = ref(null)
const tokenRotatingId = ref(null)
const agentMap = computed(() => new Map(agentOptions.value.map((item) => [item.id, item])))
const projectMap = computed(() => new Map(projects.value.map((item) => [item.id, item])))
const metrics = computed(() => [
  { label: '有效代理', value: `${formatNumber(dashboard.value.active_agents)} / ${formatNumber(dashboard.value.agents_total)}`, note: '有效 / 全部代理', tone: 'blue' },
  { label: '渠道数量', value: formatNumber(dashboard.value.channels_total), note: '已生成分发渠道', tone: 'purple' },
  { label: '归属用户', value: formatNumber(dashboard.value.attributed_users), note: '注册后锁定归属', tone: 'green' },
  { label: '渠道成交额', value: formatCentAmount(dashboard.value.gross_amount_cent || 0), note: `${formatNumber(dashboard.value.paid_orders)} 笔已支付订单`, tone: 'orange' },
])

async function loadAgents() {
  agentLoading.value = true
  try { const result = await agentsApi.list(agentQuery); agents.value = result.items; agentTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '代理列表加载失败')) } finally { agentLoading.value = false }
}
async function loadChannels() {
  channelLoading.value = true
  try { const result = await channelsApi.list(channelQuery); channels.value = result.items; channelTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '渠道列表加载失败')) } finally { channelLoading.value = false }
}
async function loadOptions() {
  try {
    const [agentResult, projectResult] = await Promise.all([
      agentsApi.list({ page: 1, page_size: 100 }), projectsApi.list({ page: 1, page_size: 100 }),
    ])
    agentOptions.value = agentResult.items
    projects.value = projectResult.items
  } catch (error) { ElMessage.error(getApiError(error, '代理或项目选项加载失败')) }
}
async function loadDashboard() {
  try { dashboard.value = await agentsApi.dashboard() || {} }
  catch (error) { ElMessage.error(getApiError(error, '渠道概览加载失败')) }
}
function openAgent(agent = null) { editingAgent.value = agent; agentDialog.value = true }
function openChannel(channel = null) { editingChannel.value = channel; channelDialog.value = true }
function viewAgent(agent) { selectedAgent.value = agent; detailDrawer.value = true }

async function saveAgent(payload) {
  submitting.value = true
  try {
    if (editingAgent.value) await agentsApi.update(editingAgent.value.id, payload)
    else await agentsApi.create(payload)
    ElMessage.success(editingAgent.value ? '代理资料已更新' : '代理已创建')
    agentDialog.value = false
    await Promise.all([loadAgents(), loadOptions(), loadDashboard()])
  } catch (error) { ElMessage.error(getApiError(error, '代理保存失败')) } finally { submitting.value = false }
}
async function saveChannel(payload) {
  submitting.value = true
  try {
    if (editingChannel.value) {
      await channelsApi.update(editingChannel.value.id, payload)
      ElMessage.success('渠道已更新')
    } else {
      tokenChannel.value = await channelsApi.create(payload)
      ElMessage.success('渠道与分发 Token 已生成')
      tokenDialog.value = true
    }
    channelDialog.value = false
    await Promise.all([loadChannels(), loadDashboard()])
  } catch (error) { ElMessage.error(getApiError(error, '渠道保存失败')) } finally { submitting.value = false }
}
async function toggleAgentStatus(agent) {
  const enabling = agent.status === 'disabled'
  const action = enabling ? '启用' : '禁用'
  try {
    await ElMessageBox.confirm(enabling ? '确定重新启用该代理吗？' : '禁用后该代理的渠道将无法继续用于新注册，历史归属与订单不会改变。', `${action}代理`, { type: enabling ? 'info' : 'warning', confirmButtonText: action, cancelButtonText: '取消' })
    statusChangingId.value = `agent-${agent.id}`
    await agentsApi.updateStatus(agent.id, enabling ? 'active' : 'disabled')
    ElMessage.success(`代理已${action}`)
    await Promise.all([loadAgents(), loadOptions(), loadDashboard()])
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, `${action}代理失败`)) } finally { statusChangingId.value = null }
}
async function toggleChannelStatus(channel) {
  const enabling = channel.status === 'disabled'
  const action = enabling ? '启用' : '禁用'
  try {
    await ElMessageBox.confirm(enabling ? '确定重新启用该渠道吗？' : '禁用后该渠道凭证不能用于新的注册归属。', `${action}渠道`, { type: enabling ? 'info' : 'warning', confirmButtonText: action, cancelButtonText: '取消' })
    statusChangingId.value = `channel-${channel.id}`
    await channelsApi.updateStatus(channel.id, enabling ? 'active' : 'disabled')
    ElMessage.success(`渠道已${action}`)
    await loadChannels()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, `${action}渠道失败`)) } finally { statusChangingId.value = null }
}
async function rotateToken(channel) {
  try {
    await ElMessageBox.confirm('轮换后旧分发 Token 立即失效，已安装且尚未注册的旧安装包也将无法归属。确定继续吗？', '轮换分发 Token', { type: 'warning', confirmButtonText: '确认轮换', cancelButtonText: '取消' })
    tokenRotatingId.value = channel.id
    tokenChannel.value = await channelsApi.rotateToken(channel.id)
    tokenDialog.value = true
    ElMessage.success('新的分发 Token 已生成')
    await loadChannels()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, 'Token 轮换失败')) } finally { tokenRotatingId.value = null }
}
async function removeAgent(agent) {
  try {
    await ElMessageBox.confirm(
      `永久删除代理“${agent.name}”？存在渠道、归属用户或订单时请先删除关联数据。`,
      '永久删除代理',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await agentsApi.remove(agent.id)
    ElMessage.success('代理已删除')
    await Promise.all([loadAgents(), loadOptions(), loadDashboard()])
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '代理删除失败')) }
}
async function removeChannel(channel) {
  try {
    await ElMessageBox.confirm(
      `永久删除渠道“${channel.name || channel.code}”？存在归属用户或订单时请先删除关联数据。`,
      '永久删除渠道',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await channelsApi.remove(channel.id)
    ElMessage.success('渠道已删除')
    await Promise.all([loadChannels(), loadDashboard()])
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '渠道删除失败')) }
}
function queryAgents() { agentQuery.page = 1; loadAgents() }
function queryChannels() { channelQuery.page = 1; loadChannels() }
onMounted(() => Promise.all([loadAgents(), loadChannels(), loadOptions(), loadDashboard()]))
</script>

<template>
  <div class="page-stack">
    <page-header title="代理与渠道" description="代理归属在手机号注册验证成功时锁定，重新安装不会覆盖历史归属">
      <template #actions><el-button :icon="Plus" @click="openAgent()">新增代理</el-button><el-button type="primary" :icon="Key" :disabled="!agentOptions.length || !projects.length" @click="openChannel()">生成渠道</el-button></template>
    </page-header>
    <section class="metric-grid"><metric-card v-for="item in metrics" :key="item.label" v-bind="item" /></section>
    <el-card shadow="never" class="surface-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="代理管理" name="agents">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-input v-model="agentQuery.keyword" clearable placeholder="搜索代理名称或编号" style="width:250px" @keyup.enter="queryAgents" @clear="queryAgents" /><el-select v-model="agentQuery.status" clearable placeholder="全部状态" style="width:130px" @change="queryAgents"><el-option label="正常" value="active" /><el-option label="已禁用" value="disabled" /></el-select><el-button type="primary" @click="queryAgents">查询</el-button></div></div>
          <el-table v-loading="agentLoading" :data="agents" stripe>
            <el-table-column label="代理" min-width="180"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.name }}</strong><span class="mono">{{ row.code }}</span></div></template></el-table-column>
            <el-table-column label="联系人" min-width="150"><template #default="{ row }">{{ row.contact_name || '—' }}<br /><span class="muted">{{ maskedPhone(row.contact_phone) }}</span></template></el-table-column>
            <el-table-column label="默认佣金" width="110"><template #default="{ row }">{{ formatRateBps(row.default_commission_rate_bps) }}</template></el-table-column>
            <el-table-column label="用户 / 订单" width="130"><template #default="{ row }">{{ formatNumber(row.user_count) }} / {{ formatNumber(row.order_count) }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="368" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="View" @click="viewAgent(row)">归属</el-button><el-button text type="primary" :icon="Edit" @click="openAgent(row)">编辑</el-button><el-button text :type="row.status === 'disabled' ? 'primary' : 'warning'" :icon="row.status === 'disabled' ? Unlock : Lock" :loading="statusChangingId === `agent-${row.id}`" @click="toggleAgentStatus(row)">{{ row.status === 'disabled' ? '启用' : '禁用' }}</el-button><el-button text type="danger" :icon="Delete" @click="removeAgent(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无代理" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="agentQuery.page" v-model:page-size="agentQuery.page_size" background layout="total, sizes, prev, pager, next" :total="agentTotal" @change="loadAgents" /></div>
        </el-tab-pane>
        <el-tab-pane label="分发渠道" name="channels">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="channelQuery.agent_id" clearable filterable placeholder="全部代理" style="width:190px" @change="queryChannels"><el-option v-for="agent in agentOptions" :key="agent.id" :label="agent.name" :value="agent.id" /></el-select><el-select v-model="channelQuery.project_id" clearable filterable placeholder="全部项目" style="width:190px" @change="queryChannels"><el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" /></el-select><el-select v-model="channelQuery.status" clearable placeholder="全部状态" style="width:130px" @change="queryChannels"><el-option label="启用" value="active" /><el-option label="已禁用" value="disabled" /></el-select><el-button type="primary" @click="queryChannels">筛选</el-button></div></div>
          <el-table v-loading="channelLoading" :data="channels" stripe>
            <el-table-column label="渠道" min-width="180"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.name || row.code }}</strong><span class="mono">{{ row.code }}</span></div></template></el-table-column>
            <el-table-column label="代理 / 项目" min-width="180"><template #default="{ row }">{{ agentMap.get(row.agent_id)?.name || row.agent_id }}<br /><span class="muted">{{ projectMap.get(row.project_id)?.name || row.project_id }}</span></template></el-table-column>
            <el-table-column label="活动" min-width="130"><template #default="{ row }">{{ row.campaign || '—' }}</template></el-table-column>
            <el-table-column label="Token 标识" min-width="140"><template #default="{ row }"><span class="mono">{{ row.token_prefix ? `${row.token_prefix}••••` : '—' }}</span></template></el-table-column>
            <el-table-column label="创建时间" width="165"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="408" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Key" :loading="tokenRotatingId === row.id" @click="rotateToken(row)">轮换 Token</el-button><el-button text type="primary" :icon="Edit" @click="openChannel(row)">编辑</el-button><el-button text :type="row.status === 'disabled' ? 'primary' : 'warning'" :icon="row.status === 'disabled' ? Unlock : Lock" :loading="statusChangingId === `channel-${row.id}`" @click="toggleChannelStatus(row)">{{ row.status === 'disabled' ? '启用' : '禁用' }}</el-button><el-button text type="danger" :icon="Delete" @click="removeChannel(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无分发渠道" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="channelQuery.page" v-model:page-size="channelQuery.page_size" background layout="total, sizes, prev, pager, next" :total="channelTotal" @change="loadChannels" /></div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <agent-form-dialog v-model="agentDialog" :agent="editingAgent" :projects="projects" :submitting="submitting" @submit="saveAgent" />
    <channel-form-dialog v-model="channelDialog" :channel="editingChannel" :agents="agentOptions" :projects="projects" :submitting="submitting" @submit="saveChannel" />
    <distribution-token-dialog v-model="tokenDialog" :channel="tokenChannel" />
    <agent-attribution-drawer v-model="detailDrawer" :agent="selectedAgent" />
  </div>
</template>

<style scoped>
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.tab-toolbar{min-height:44px;margin-bottom:15px}.primary-cell{display:flex;flex-direction:column;gap:5px}.primary-cell span{color:var(--lc-muted);font-size:12px}
@media(max-width:1180px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.metric-grid{grid-template-columns:1fr}}
</style>
