<script setup>
import { computed, onMounted, ref } from 'vue'
import { Connection, Delete, Edit, Key, Plus, RefreshRight, Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { apiPoolApi, crossBorderProviderApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import ApiKeyDialog from '../components/apiPool/ApiKeyDialog.vue'
import ApiProviderDialog from '../components/apiPool/ApiProviderDialog.vue'
import ApiProviderEndpointDialog from '../components/apiPool/ApiProviderEndpointDialog.vue'
import ApiQuickConnectDialog from '../components/apiPool/ApiQuickConnectDialog.vue'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { formatDateTime } from '../utils/formatters.js'

const loading = ref(false)
const submitting = ref(false)
const summary = ref({})
const providers = ref([])
const selectedProviderId = ref(null)
const keys = ref([])
const models = ref([])
const activeTab = ref('keys')
const providerDialog = ref(false)
const endpointDialog = ref(false)
const quickConnectDialog = ref(false)
const keyDialog = ref(false)
const editingProvider = ref(null)
const editingKey = ref(null)
const keyMode = ref('create')
const quickInitialUrl = ref('')
const crossBorderStatus = ref({ configured: false, token_state_present: false })
const crossBorderDialog = ref(false)
const crossBorderSecret = ref('')
const selectedProvider = computed(() => providers.value.find((item) => item.id === selectedProviderId.value) || null)

function statusType(status) {
  return ({ active: 'success', disabled: 'info', invalid: 'danger' })[status] || 'warning'
}
function kindLabel(kind) { return ({ text: '文本', image: '图片', seerfar: 'Seerfar' })[kind] || kind }

async function loadProviders({ preserve = true } = {}) {
  const [summaryResult, providerResult] = await Promise.all([
    apiPoolApi.summary(), apiPoolApi.providers(),
  ])
  summary.value = summaryResult
  providers.value = providerResult
  const currentExists = providerResult.some((item) => item.id === selectedProviderId.value)
  if (!preserve || !currentExists) selectedProviderId.value = providerResult[0]?.id || null
}
async function loadProviderDetails() {
  if (!selectedProviderId.value) { keys.value = []; models.value = []; return }
  const [keyResult, modelResult] = await Promise.all([
    apiPoolApi.keys(selectedProviderId.value), apiPoolApi.models(selectedProviderId.value),
  ])
  keys.value = keyResult
  models.value = modelResult
}
async function reload() {
  loading.value = true
  try {
    await Promise.all([
      loadProviders(),
      crossBorderProviderApi.status().then((value) => { crossBorderStatus.value = value }),
    ])
    await loadProviderDetails()
  }
  catch (error) { ElMessage.error(getApiError(error, 'API 池读取失败')) }
  finally { loading.value = false }
}
function openCrossBorderSecret() {
  crossBorderSecret.value = ''
  crossBorderDialog.value = true
}
async function saveCrossBorderSecret() {
  const secret = crossBorderSecret.value.trim()
  if (!secret) { ElMessage.error('请输入跨境巴士企业 API'); return }
  submitting.value = true
  try {
    await crossBorderProviderApi.saveSecret(secret)
    crossBorderSecret.value = ''
    crossBorderDialog.value = false
    crossBorderStatus.value = await crossBorderProviderApi.status()
    ElMessage.success('跨境巴士企业 API 已保存到服务器，客户端无需配置')
  } catch (error) { ElMessage.error(getApiError(error, '跨境巴士企业 API 保存失败')) }
  finally { submitting.value = false }
}
async function selectProvider(row) {
  if (selectedProviderId.value === row.id) return
  selectedProviderId.value = row.id
  loading.value = true
  try { await loadProviderDetails() }
  catch (error) { ElMessage.error(getApiError(error, '供应商详情读取失败')) }
  finally { loading.value = false }
}

function openProvider(item = null) { editingProvider.value = item; providerDialog.value = true }
function openEndpoint(item) { editingProvider.value = item; endpointDialog.value = true }
function openQuickConnect(baseUrl = '') {
  quickInitialUrl.value = baseUrl
  quickConnectDialog.value = true
}
async function autoConnect(payload) {
  submitting.value = true
  try {
    const result = await apiPoolApi.autoConnect(payload)
    selectedProviderId.value = result.provider.id
    quickConnectDialog.value = false
    const keyMessage = result.key_created ? 'API Key 已加入密钥池' : '这个 API Key 已经存在'
    ElMessage.success(`${keyMessage}，自动识别 ${result.discovered_model_count} 个模型`)
    await reload()
  } catch (error) { ElMessage.error(getApiError(error, 'API 自动识别失败')) }
  finally { submitting.value = false }
}
async function saveProvider(payload) {
  submitting.value = true
  try {
    const saved = editingProvider.value
      ? await apiPoolApi.updateProvider(editingProvider.value.id, payload)
      : await apiPoolApi.createProvider(payload)
    selectedProviderId.value = saved.id
    providerDialog.value = false
    ElMessage.success('API 供应商已保存')
    await reload()
  } catch (error) { ElMessage.error(getApiError(error, '供应商保存失败')) }
  finally { submitting.value = false }
}
async function replaceEndpoint(payload) {
  if (!editingProvider.value) return
  submitting.value = true
  try {
    const saved = await apiPoolApi.replaceProviderEndpoint(editingProvider.value.id, payload)
    selectedProviderId.value = saved.id
    endpointDialog.value = false
    ElMessage.success('新地址验证通过，下一次调用立即生效')
    await reload()
  } catch (error) { ElMessage.error(getApiError(error, '接口地址切换失败')) }
  finally { submitting.value = false }
}
async function removeProvider(item) {
  try {
    await ElMessageBox.confirm(
      `永久删除“${item.name}”？该供应商下的 Key、模型和调度状态会一起清理。`,
      '删除 API 供应商',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await apiPoolApi.removeProvider(item.id)
    selectedProviderId.value = null
    ElMessage.success('API 供应商已删除')
    await reload()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '供应商删除失败')) }
}

function openKey(mode, item = null) { keyMode.value = mode; editingKey.value = item; keyDialog.value = true }
async function saveKey(payload) {
  if (!selectedProvider.value) return
  submitting.value = true
  try {
    if (keyMode.value === 'create') await apiPoolApi.createKey(selectedProvider.value.id, payload)
    else if (keyMode.value === 'rotate') await apiPoolApi.rotateKey(editingKey.value.id, payload)
    else await apiPoolApi.updateKey(editingKey.value.id, payload)
    keyDialog.value = false
    ElMessage.success(keyMode.value === 'rotate' ? 'API Key 已安全更换' : 'API Key 已保存')
    await reload()
  } catch (error) { ElMessage.error(getApiError(error, 'API Key 保存失败')) }
  finally { submitting.value = false }
}
async function removeKey(item) {
  try {
    await ElMessageBox.confirm(
      `永久删除“${item.label}” ${item.masked_hint}？正在执行的任务不会被强制中断。`,
      '删除 API Key',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await apiPoolApi.removeKey(item.id)
    ElMessage.success('API Key 已删除')
    await reload()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, 'API Key 删除失败')) }
}

onMounted(reload)
</script>

<template>
  <div class="page-stack">
    <page-header title="API 池" description="添加时只填接口网址和 API Key，系统自动验证、识别模型并分配空闲 Key">
      <template #actions><el-button :icon="RefreshRight" :loading="loading" @click="reload">刷新</el-button><el-button type="primary" :icon="Plus" @click="openQuickConnect()">添加 API</el-button></template>
    </page-header>
    <div class="metric-grid">
      <el-card shadow="never" class="metric-card"><span>已接入接口</span><strong>{{ summary.active_provider_count || 0 }} / {{ summary.provider_count || 0 }}</strong><small>启用 / 全部</small></el-card>
      <el-card shadow="never" class="metric-card"><span>可用 Key</span><strong>{{ summary.available_key_count || 0 }} / {{ summary.key_count || 0 }}</strong><small>{{ summary.cooling_key_count || 0 }} 个暂时不可用</small></el-card>
      <el-card shadow="never" class="metric-card"><span>已识别模型</span><strong>{{ summary.model_count || 0 }}</strong><small>系统自动读取，无需填写</small></el-card>
      <el-card shadow="never" class="metric-card"><span>正在调用</span><strong>{{ summary.active_lease_count || 0 }}</strong><small>按 Key 独立计算并发</small></el-card>
    </div>
    <el-alert title="完整 Key 只会加密保存在服务端。一个 Key 暂时不可用时，系统会自动换用其他 Key。" type="warning" :closable="false" show-icon />
    <el-card shadow="never" class="surface-card cross-border-provider-card">
      <div class="cross-border-provider-row">
        <div class="primary-cell">
          <strong>跨境巴士企业授权</strong>
          <span>企业 API 和企业 Token 只保存在本服务器；客户端只获得不透明用户授权。</span>
        </div>
        <div class="cross-border-provider-actions">
          <el-tag :type="crossBorderStatus.configured ? 'success' : 'warning'" effect="plain">
            {{ crossBorderStatus.configured ? '服务器已配置' : '等待配置' }}
          </el-tag>
          <el-tag v-if="crossBorderStatus.token_state_present" type="info" effect="plain">Token 已建立</el-tag>
          <el-button type="primary" :icon="Key" @click="openCrossBorderSecret">
            {{ crossBorderStatus.configured ? '更换企业 API' : '配置企业 API' }}
          </el-button>
        </div>
      </div>
    </el-card>
    <div class="content-grid">
      <el-card shadow="never" class="surface-card provider-card">
        <template #header><div class="card-header"><div><strong>已接入 API</strong><span>点击一项查看对应 Key 和自动识别结果</span></div></div></template>
        <el-table v-loading="loading" :data="providers" highlight-current-row :current-row-key="selectedProviderId" row-key="id" @row-click="selectProvider">
          <el-table-column label="接口" min-width="260"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.name }}</strong><span>{{ row.code }}</span></div></template></el-table-column>
          <el-table-column label="能力" width="110"><template #default="{ row }"><el-tag v-for="kind in row.capability_kinds" :key="kind" size="small" effect="plain">{{ kindLabel(kind) }}</el-tag></template></el-table-column>
          <el-table-column label="资源" width="110"><template #default="{ row }">{{ row.active_key_count }}/{{ row.key_count }} Key<br /><span class="muted">{{ row.model_count }} 模型</span></template></el-table-column>
          <el-table-column label="状态" width="80"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
          <el-table-column label="操作" width="300"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Connection" :disabled="row.adapter !== 'openai-compatible'" @click.stop="openEndpoint(row)">更换地址</el-button><el-button text type="primary" :icon="Edit" @click.stop="openProvider(row)">高级设置</el-button><el-button text type="danger" :icon="Delete" @click.stop="removeProvider(row)">删除</el-button></div></template></el-table-column>
          <template #empty><el-empty description="点击右上角“添加 API”，只需填写网址和 Key" /></template>
        </el-table>
      </el-card>
      <el-card shadow="never" class="surface-card detail-card">
        <template #header><div class="card-header"><div><strong>{{ selectedProvider?.name || '供应商详情' }}</strong><span v-if="selectedProvider">{{ selectedProvider.base_url }}</span><span v-else>选择左侧供应商</span></div></div></template>
        <el-tabs v-model="activeTab">
          <el-tab-pane :label="`API Key (${keys.length})`" name="keys">
            <div class="section-toolbar"><span class="muted">调度优先选空闲且近期最少使用的 Key</span><el-button type="primary" :icon="Key" :disabled="!selectedProvider" @click="openQuickConnect(selectedProvider?.base_url)">添加 API Key</el-button></div>
            <el-table v-loading="loading" :data="keys" stripe>
              <el-table-column label="名称 / 掩码" min-width="175"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.label }}</strong><span class="mono">{{ row.masked_hint }}</span></div></template></el-table-column>
              <el-table-column label="并发" width="100"><template #default="{ row }">{{ row.active_leases }}/{{ row.max_concurrency === 0 ? '不限' : row.max_concurrency }}</template></el-table-column>
              <el-table-column label="成功 / 失败" width="115"><template #default="{ row }">{{ row.success_count }} / {{ row.failure_count }}</template></el-table-column>
              <el-table-column label="状态" width="105"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ row.status }}</el-tag><div v-if="row.cooldown_until" class="tiny">至 {{ formatDateTime(row.cooldown_until) }}</div></template></el-table-column>
              <el-table-column label="最近使用" width="155"><template #default="{ row }">{{ row.last_used_at ? formatDateTime(row.last_used_at) : '未使用' }}</template></el-table-column>
              <el-table-column label="操作" width="282" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openKey('edit', row)">设置</el-button><el-button text type="warning" :icon="Refresh" @click="openKey('rotate', row)">换 Key</el-button><el-button text type="danger" :icon="Delete" @click="removeKey(row)">删除</el-button></div></template></el-table-column>
              <template #empty><el-empty description="暂无 API Key" /></template>
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="`已识别模型 (${models.length})`" name="models">
            <div class="section-toolbar"><span class="muted">模型由系统通过接口自动识别，无需手工填写</span></div>
            <el-table v-loading="loading" :data="models" stripe>
              <el-table-column label="模型" min-width="210"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.display_name }}</strong><span class="mono">{{ row.model_code }}</span></div></template></el-table-column>
              <el-table-column label="类型" width="95"><template #default="{ row }">{{ kindLabel(row.capability_kind) }}</template></el-table-column>
              <el-table-column prop="priority" label="优先级" width="90" />
              <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
              <template #empty><el-empty description="重新点击“添加 API”即可自动识别模型" /></template>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </div>
    <api-quick-connect-dialog v-model="quickConnectDialog" :initial-url="quickInitialUrl" :submitting="submitting" @submit="autoConnect" />
    <api-provider-dialog v-model="providerDialog" :provider="editingProvider" :submitting="submitting" @submit="saveProvider" />
    <api-provider-endpoint-dialog v-model="endpointDialog" :provider="editingProvider" :submitting="submitting" @submit="replaceEndpoint" />
    <api-key-dialog v-model="keyDialog" :key-item="editingKey" :mode="keyMode" :submitting="submitting" @submit="saveKey" />
    <el-dialog v-model="crossBorderDialog" title="跨境巴士企业 API" width="min(520px, calc(100vw - 32px))" destroy-on-close>
      <el-alert title="此密钥只写入服务器专用密钥文件，不会返回页面、下发客户端或写入日志。" type="warning" :closable="false" show-icon />
      <el-form label-position="top" style="margin-top:16px">
        <el-form-item label="企业 API">
          <el-input v-model="crossBorderSecret" type="password" show-password autocomplete="new-password" placeholder="输入新的企业 API" />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="crossBorderDialog=false">取消</el-button><el-button type="primary" :loading="submitting" @click="saveCrossBorderSecret">保存到服务器</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.metric-card :deep(.el-card__body){display:flex;flex-direction:column;gap:7px}.metric-card span,.metric-card small,.muted,.primary-cell span,.card-header span{color:var(--lc-muted)}.metric-card strong{font-size:25px;color:#172033}.content-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}.provider-card,.detail-card{width:100%;min-width:0}.card-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.card-header>div,.primary-cell{display:flex;flex-direction:column;gap:5px;min-width:0}.primary-cell strong,.primary-cell span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card-header span{font-size:12px;max-width:640px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.section-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:42px;margin-bottom:12px}.table-actions{display:flex;align-items:center;gap:4px;white-space:nowrap}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.tiny{margin-top:4px;color:var(--lc-muted);font-size:11px}.el-tag+.el-tag{margin-left:4px}.cross-border-provider-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.cross-border-provider-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}@media(max-width:900px){.metric-grid{grid-template-columns:repeat(2,1fr)}.cross-border-provider-row{align-items:flex-start;flex-direction:column}}@media(max-width:560px){.metric-grid{grid-template-columns:1fr}.section-toolbar{align-items:flex-start;flex-direction:column}}
</style>
