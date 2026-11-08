<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, SwitchButton } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { permissionsApi, plansApi, productsApi, projectsApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import PermissionFormDialog from '../components/plans/PermissionFormDialog.vue'
import PlanFormDialog from '../components/plans/PlanFormDialog.vue'
import { getPlanDeleteError, isPlanDependencyConflict } from '../components/plans/planDeletion.js'
import { formatCurrency } from '../utils/formatters.js'

const activeTab = ref('plans')
const loading = ref(false)
const submitting = ref(false)
const plans = ref([])
const products = ref([])
const projects = ref([])
const permissions = ref([])
const permissionOptions = ref([])
const planTotal = ref(0)
const permissionTotal = ref(0)
const planQuery = reactive({ product_id: '', page: 1, page_size: 20 })
const permissionQuery = reactive({ project_id: '', page: 1, page_size: 200 })
const planDialog = ref(false)
const permissionDialog = ref(false)
const planActionId = ref(null)
const editingPlan = ref(null)
const editingPermission = ref(null)
const productMap = computed(() => new Map(products.value.map((item) => [item.id, `${item.name} · ${item.version}`])))
const projectMap = computed(() => new Map(projects.value.map((item) => [item.id, item.name])))
const licenseRoleLabels = {
  legacy: '历史兼容',
  shop_intro: '首店首月卡',
  shop_standard_monthly: '标准月卡',
  shop_standard_annual: '标准年卡',
}

async function loadPlans() {
  loading.value = true
  try { const result = await plansApi.list(planQuery); plans.value = result.items; planTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '套餐列表加载失败')) } finally { loading.value = false }
}
async function loadPermissions() {
  loading.value = true
  try { const result = await permissionsApi.list(permissionQuery); permissions.value = result.items; permissionTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '权限列表加载失败')) } finally { loading.value = false }
}
async function loadProducts() {
  try { products.value = (await productsApi.list({ page: 1, page_size: 100 })).items }
  catch (error) { ElMessage.error(getApiError(error, '产品选项加载失败')) }
}
async function loadPermissionOptions() {
  try { permissionOptions.value = (await permissionsApi.list({ page: 1, page_size: 200 })).items }
  catch (error) { ElMessage.error(getApiError(error, '权限选项加载失败')) }
}
async function loadProjects() {
  try { projects.value = (await projectsApi.list({ page: 1, page_size: 100 })).items }
  catch (error) { ElMessage.error(getApiError(error, '项目选项加载失败')) }
}
function openPlan(plan = null) { editingPlan.value = plan; planDialog.value = true }
function openPermission(permission = null) { editingPermission.value = permission; permissionDialog.value = true }
async function savePlan(payload) {
  submitting.value = true
  try { if (editingPlan.value) { const changes = { ...payload }; delete changes.product_id; await plansApi.update(editingPlan.value.id, changes) } else await plansApi.create(payload); ElMessage.success('套餐已保存'); planDialog.value = false; await loadPlans() }
  catch (error) { ElMessage.error(getApiError(error, '套餐保存失败')) } finally { submitting.value = false }
}
async function savePermission(payload) {
  submitting.value = true
  try { if (editingPermission.value) await permissionsApi.update(editingPermission.value.id, payload); else await permissionsApi.create(payload); ElMessage.success('权限已保存'); permissionDialog.value = false; await Promise.all([loadPermissions(), loadPermissionOptions()]) }
  catch (error) { ElMessage.error(getApiError(error, '权限保存失败')) } finally { submitting.value = false }
}
function isDialogCancelled(error) { return error === 'cancel' || error === 'close' }
async function stopOnlineSale(plan, options = {}) {
  const { confirm = true } = options
  try {
    if (confirm) {
      await ElMessageBox.confirm(
        `停售后，新用户将无法在线购买“${plan.name}”；已有授权、订单和历史数据不会被删除。确定停售吗？`,
        '停售套餐',
        { type: 'warning', confirmButtonText: '确认停售', cancelButtonText: '取消' },
      )
    }
    planActionId.value = plan.id
    await plansApi.stopSales(plan.id)
    ElMessage.success('套餐已停售，历史数据已保留')
    await loadPlans()
    return true
  } catch (error) {
    if (!isDialogCancelled(error)) ElMessage.error(getApiError(error, '套餐停售失败'))
    return false
  } finally { planActionId.value = null }
}
async function handlePlanDeleteConflict(plan, error) {
  const message = getPlanDeleteError(error)
  if (!plan.online_sale_enabled) { ElMessage.warning(`${message} 当前套餐已处于未开售状态。`); return }
  try {
    await ElMessageBox.confirm(`${message} 是否改为立即停售？`, '套餐已有历史数据', {
      type: 'warning', confirmButtonText: '立即停售', cancelButtonText: '保持在售',
    })
    await stopOnlineSale(plan, { confirm: false })
  } catch (dialogError) {
    if (!isDialogCancelled(dialogError)) ElMessage.error(getApiError(dialogError, '套餐处理失败'))
  }
}
async function removePlan(plan) {
  try {
    await ElMessageBox.confirm(
      `仅从未产生授权、卡密、订单或分佣记录的套餐可以永久删除。确定删除“${plan.name}”吗？`,
      '永久删除套餐',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    planActionId.value = plan.id
    await plansApi.remove(plan.id)
    ElMessage.success('套餐已删除')
    await loadPlans()
  } catch (error) {
    if (isDialogCancelled(error)) return
    if (isPlanDependencyConflict(error)) { await handlePlanDeleteConflict(plan, error); return }
    ElMessage.error(getPlanDeleteError(error))
  } finally { planActionId.value = null }
}
async function removePermission(permission) {
  try {
    await ElMessageBox.confirm(`确定删除权限“${permission.name}”吗？已关联套餐时将无法删除。`, '删除权限', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await permissionsApi.remove(permission.id); ElMessage.success('权限已删除'); await Promise.all([loadPermissions(), loadPermissionOptions()])
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, '权限删除失败')) }
}
onMounted(async () => { await Promise.all([loadProjects(), loadProducts(), loadPermissions(), loadPermissionOptions(), loadPlans()]) })
</script>

<template>
  <div class="page-stack">
    <page-header title="套餐与权限" description="配置产品售价、授权周期、资源配额与服务端权限集合">
      <template #actions><el-button type="primary" :icon="Plus" :disabled="!products.length" @click="openPlan()">创建套餐</el-button></template>
    </page-header>
    <el-card shadow="never" class="surface-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="套餐管理" name="plans">
          <el-alert class="plan-lifecycle-tip" title="不再对外销售时请使用“停售”" description="停售只会关闭新用户在线购买，不会更改套餐状态，也不会删除或影响已有授权和历史数据。已有业务记录的套餐不能永久删除。" type="info" :closable="false" show-icon />
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="planQuery.product_id" clearable filterable placeholder="全部产品" style="width:250px" @change="loadPlans"><el-option v-for="item in products" :key="item.id" :label="`${item.name} · ${item.version}`" :value="item.id" /></el-select><el-button type="primary" @click="loadPlans">刷新</el-button></div></div>
          <el-table v-loading="loading" :data="plans" stripe>
            <el-table-column label="套餐" min-width="170"><template #default="{ row }"><strong>{{ row.name }}</strong><br /><el-tag size="small" effect="plain">{{ licenseRoleLabels[row.license_role] || row.license_role }}</el-tag></template></el-table-column>
            <el-table-column label="所属产品" min-width="180"><template #default="{ row }">{{ row.product?.name || productMap.get(row.product_id) || row.product_id }}</template></el-table-column>
            <el-table-column label="价格 / 在线销售" width="190"><template #default="{ row }"><div class="price-cell"><strong>{{ formatCurrency(row.price) }} / {{ row.duration_days }} 天</strong><span>在线 {{ formatCurrency(Number(row.sale_price_cent || 0) / 100) }}</span><el-tag size="small" :type="row.online_sale_enabled ? 'success' : 'info'" effect="plain">{{ row.online_sale_enabled ? '已开售' : '未开售' }}</el-tag></div></template></el-table-column>
            <el-table-column label="资源上限" width="150"><template #default="{ row }"><span>设备 {{ row.max_devices }} · 店铺 {{ row.max_shops }}</span></template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="权限" min-width="240"><template #default="{ row }"><div class="permission-tags"><el-tag v-for="permission in row.permissions || []" :key="permission.id || permission.code" size="small" effect="plain">{{ permission.name || permission.code }}</el-tag><span v-if="!(row.permissions || []).length" class="empty-dash">未配置</span></div></template></el-table-column>
            <el-table-column label="操作" width="282" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openPlan(row)">编辑</el-button><el-button v-if="row.online_sale_enabled" text type="warning" :icon="SwitchButton" :loading="planActionId === row.id" @click="stopOnlineSale(row)">停售</el-button><el-button text type="danger" :icon="Delete" :loading="planActionId === row.id" @click="removePlan(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无套餐" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="planQuery.page" v-model:page-size="planQuery.page_size" background layout="total, sizes, prev, pager, next" :total="planTotal" @change="loadPlans" /></div>
        </el-tab-pane>
        <el-tab-pane label="权限字典" name="permissions">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="permissionQuery.project_id" clearable filterable placeholder="全部软件项目" style="width:250px" @change="loadPermissions"><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="primary" @click="loadPermissions">刷新</el-button></div><el-button type="primary" :icon="Plus" :disabled="!projects.length" @click="openPermission()">新增权限</el-button></div>
          <el-table v-loading="loading" :data="permissions" stripe><el-table-column prop="code" label="权限代码" min-width="190"><template #default="{ row }"><span class="mono permission-code">{{ row.code }}</span></template></el-table-column><el-table-column prop="name" label="权限名称" min-width="150" /><el-table-column label="所属项目" min-width="150"><template #default="{ row }">{{ projectMap.get(row.project_id) || row.project_id }}</template></el-table-column><el-table-column prop="description" label="说明" min-width="240" show-overflow-tooltip /><el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openPermission(row)">编辑</el-button><el-button text type="danger" :icon="Delete" @click="removePermission(row)">删除</el-button></div></template></el-table-column><template #empty><el-empty description="暂无权限" /></template></el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="permissionQuery.page" v-model:page-size="permissionQuery.page_size" background layout="total, sizes, prev, pager, next" :total="permissionTotal" @change="loadPermissions" /></div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <plan-form-dialog v-model="planDialog" :plan="editingPlan" :products="products" :permissions="permissionOptions" :submitting="submitting" @submit="savePlan" />
    <permission-form-dialog v-model="permissionDialog" :permission="editingPermission" :projects="projects" :submitting="submitting" @submit="savePermission" />
  </div>
</template>

<style scoped>.plan-lifecycle-tip{margin-bottom:15px}.tab-toolbar{min-height:44px;margin-bottom:15px}.price-cell{display:flex;flex-direction:column;align-items:flex-start;gap:4px}.price-cell strong{color:#172033}.price-cell span{color:var(--lc-muted);font-size:12px}.permission-tags{display:flex;flex-wrap:wrap;gap:5px}.permission-code{padding:5px 8px;border-radius:6px;color:#315efb;background:#f0f4ff;font-size:12px}</style>
