<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Delete, Download, Lock, Plus, Unlock, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { cardBatchesApi, plansApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import BatchCodesDialog from '../components/cards/BatchCodesDialog.vue'
import GenerateBatchDialog from '../components/cards/GenerateBatchDialog.vue'
import GeneratedCodesDialog from '../components/cards/GeneratedCodesDialog.vue'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { formatDateTime, formatNumber } from '../utils/formatters.js'

const loading = ref(false)
const submitting = ref(false)
const exportingId = ref(null)
const statusChangingId = ref(null)
const deletingId = ref(null)
const batches = ref([])
const plans = ref([])
const total = ref(0)
const query = reactive({ plan_id: '', page: 1, page_size: 20 })
const generateDialog = ref(false)
const codesDialog = ref(false)
const selectedBatch = ref(null)
const generatedBatch = ref(null)
const generatedDialog = ref(false)
const planMap = computed(() => new Map(plans.value.map((item) => [item.id, item.name])))
const cardPlans = computed(() => plans.value.filter((item) => ['shop_intro', 'shop_standard_monthly', 'shop_standard_annual'].includes(item.license_role)))
watch(generatedDialog, (visible) => { if (!visible) generatedBatch.value = null })

async function loadBatches() {
  loading.value = true
  try { const result = await cardBatchesApi.list(query); batches.value = result.items; total.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '卡密批次加载失败')) } finally { loading.value = false }
}
async function loadPlans() {
  try { plans.value = (await plansApi.list({ page: 1, page_size: 100 })).items }
  catch (error) { ElMessage.error(getApiError(error, '套餐选项加载失败')) }
}
async function generateBatch(payload) {
  submitting.value = true
  try {
    generatedBatch.value = await cardBatchesApi.create(payload)
    ElMessage.success('卡密批次已生成')
    generateDialog.value = false
    generatedDialog.value = true
    await loadBatches()
  }
  catch (error) { ElMessage.error(getApiError(error, '卡密生成失败')) } finally { submitting.value = false }
}
function viewCodes(batch) { selectedBatch.value = batch; codesDialog.value = true }
async function toggleBatchStatus(batch) {
  const restoring = batch.status === 'disabled'
  const nextStatus = restoring ? 'active' : 'disabled'
  const action = restoring ? '启用' : '禁用'
  const message = restoring
    ? `确定重新启用批次“${batch.name || `#${batch.id}`}”吗？`
    : `确定禁用批次“${batch.name || `#${batch.id}`}”吗？该批次内未激活卡密将无法继续激活。`
  try {
    await ElMessageBox.confirm(message, `${action}卡密批次`, {
      type: restoring ? 'info' : 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '取消',
    })
    statusChangingId.value = batch.id
    await cardBatchesApi.updateStatus(batch.id, nextStatus)
    ElMessage.success(`卡密批次已${action}`)
    await loadBatches()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, `${action}批次失败`))
  } finally { statusChangingId.value = null }
}
async function exportBatch(batch, format) {
  exportingId.value = batch.id
  try {
    const blob = await cardBatchesApi.export(batch.id, format)
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]))
    const link = document.createElement('a')
    link.href = url
    link.download = `license-cards-${batch.batch_no || batch.id}.${format}`
    link.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出文件已生成')
  } catch (error) { ElMessage.error(getApiError(error, '导出失败')) } finally { exportingId.value = null }
}
async function removeBatch(batch) {
  try {
    await ElMessageBox.confirm(
      `永久删除批次“${batch.name || `#${batch.id}`}”及其中全部 ${batch.quantity || 0} 个卡密？已激活卡密对应的 License 不会自动删除。`,
      '永久删除卡密批次',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    deletingId.value = batch.id
    await cardBatchesApi.remove(batch.id)
    ElMessage.success('卡密批次及卡密已删除')
    await loadBatches()
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '卡密批次删除失败'))
  } finally { deletingId.value = null }
}
onMounted(async () => { await Promise.all([loadBatches(), loadPlans()]) })
</script>

<template>
  <div class="page-stack">
    <page-header title="卡密管理" description="按套餐批量生成卡密，查看激活状态并导出交付文件">
      <template #actions><el-button type="primary" :icon="Plus" :disabled="!cardPlans.length" @click="generateDialog = true">批量生成卡密</el-button></template>
    </page-header>
    <el-card shadow="never" class="surface-card">
      <div class="toolbar batch-toolbar"><div class="toolbar__filters"><el-select v-model="query.plan_id" clearable filterable placeholder="全部套餐" style="width:240px" @change="loadBatches"><el-option v-for="item in plans" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="primary" @click="loadBatches">刷新</el-button></div></div>
      <el-table v-loading="loading" :data="batches" stripe>
        <el-table-column label="批次" min-width="170"><template #default="{ row }"><div class="batch-cell"><strong class="mono">{{ row.batch_no || `#${row.id}` }}</strong><span>{{ formatDateTime(row.created_at) }}</span></div></template></el-table-column>
        <el-table-column label="套餐" min-width="150"><template #default="{ row }">{{ row.plan?.name || row.plan_name || planMap.get(row.plan_id) || row.plan_id }}</template></el-table-column>
        <el-table-column label="数量" width="110"><template #default="{ row }">{{ formatNumber(row.quantity ?? row.count) }}</template></el-table-column>
        <el-table-column label="有效期" width="110"><template #default="{ row }">{{ row.validity_days || row.duration_days || '—' }} 天</template></el-table-column>
        <el-table-column label="批次截止" width="170"><template #default="{ row }">{{ formatDateTime(row.expires_at) }}</template></el-table-column>
        <el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status || 'active'" /></template></el-table-column>
        <el-table-column label="操作" width="380" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="View" @click="viewCodes(row)">明细</el-button><el-dropdown @command="exportBatch(row, $event)"><el-button text type="primary" :icon="Download" :loading="exportingId === row.id">导出</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="csv">导出 CSV</el-dropdown-item><el-dropdown-item command="xlsx">导出 Excel</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button text :type="row.status === 'disabled' ? 'primary' : 'warning'" :icon="row.status === 'disabled' ? Unlock : Lock" :loading="statusChangingId === row.id" @click="toggleBatchStatus(row)">{{ row.status === 'disabled' ? '启用' : '禁用' }}</el-button><el-button text type="danger" :icon="Delete" :loading="deletingId === row.id" @click="removeBatch(row)">删除</el-button></div></template></el-table-column>
        <template #empty><el-empty description="暂无卡密批次" /></template>
      </el-table>
      <div class="table-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.page_size" background layout="total, sizes, prev, pager, next" :total="total" @change="loadBatches" /></div>
    </el-card>
    <generate-batch-dialog v-model="generateDialog" :plans="cardPlans" :submitting="submitting" @submit="generateBatch" />
    <generated-codes-dialog v-model="generatedDialog" :batch="generatedBatch" :exporting="exportingId === generatedBatch?.id" @export="exportBatch(generatedBatch, $event)" />
    <batch-codes-dialog v-model="codesDialog" :batch="selectedBatch" />
  </div>
</template>

<style scoped>.batch-toolbar{margin-bottom:18px}.batch-cell{display:flex;flex-direction:column;gap:5px}.batch-cell span{color:var(--lc-muted);font-size:11px}</style>
