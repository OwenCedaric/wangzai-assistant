<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Remove } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { licensesApi, plansApi, usersApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import GrantLicenseDialog from '../components/licenses/GrantLicenseDialog.vue'
import UserFormDialog from '../components/licenses/UserFormDialog.vue'
import { formatDateTime } from '../utils/formatters.js'
import { userDisplayName } from '../utils/userIdentity.js'

const activeTab = ref('users')
const loading = ref(false)
const submitting = ref(false)
const users = ref([])
const plans = ref([])
const licenses = ref([])
const userTotal = ref(0)
const licenseTotal = ref(0)
const userQuery = reactive({ keyword: '', status: '', page: 1, page_size: 20 })
const licenseQuery = reactive({ user_id: '', plan_id: '', status: '', page: 1, page_size: 20 })
const userDialog = ref(false)
const grantDialog = ref(false)
const editingUser = ref(null)
function userLabel(user) {
  return userDisplayName(user)
}
const userMap = computed(() => new Map(users.value.map((item) => [item.id, userLabel(item)])))
const planMap = computed(() => new Map(plans.value.map((item) => [item.id, item.name])))

async function loadUsers() {
  loading.value = true
  try { const result = await usersApi.list(userQuery); users.value = result.items; userTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '用户列表加载失败')) } finally { loading.value = false }
}
async function loadLicenses() {
  loading.value = true
  try { const result = await licensesApi.list(licenseQuery); licenses.value = result.items; licenseTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '授权列表加载失败')) } finally { loading.value = false }
}
async function loadPlans() {
  try { plans.value = (await plansApi.list({ page: 1, page_size: 100 })).items }
  catch (error) { ElMessage.error(getApiError(error, '套餐选项加载失败')) }
}
function openUser(user = null) { editingUser.value = user; userDialog.value = true }
async function saveUser(payload) {
  submitting.value = true
  try { if (editingUser.value) await usersApi.update(editingUser.value.id, payload); else await usersApi.create(payload); ElMessage.success('用户已保存'); userDialog.value = false; await loadUsers() }
  catch (error) { ElMessage.error(getApiError(error, '用户保存失败')) } finally { submitting.value = false }
}
async function grantLicense(payload) {
  submitting.value = true
  try { await licensesApi.create(payload); ElMessage.success('License 已授予'); grantDialog.value = false; activeTab.value = 'licenses'; await loadLicenses() }
  catch (error) { ElMessage.error(getApiError(error, '授权失败')) } finally { submitting.value = false }
}
async function revokeLicense(license) {
  try {
    await ElMessageBox.confirm('撤销后客户端下次授权校验将失效，确定继续吗？', '撤销 License', { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' })
    await licensesApi.revoke(license.id); ElMessage.success('License 已撤销'); loadLicenses()
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, '撤销失败')) }
}
async function removeUser(user) {
  try {
    await ElMessageBox.confirm(
      `永久删除“${userLabel(user)}”？该用户的授权、设备、店铺、登录状态、订单归属和积分钱包会一起清理。`,
      '永久删除用户',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await usersApi.remove(user.id)
    ElMessage.success('用户及关联数据已删除')
    await Promise.all([loadUsers(), loadLicenses()])
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '用户删除失败'))
  }
}
async function removeLicense(license) {
  try {
    await ElMessageBox.confirm(
      '永久删除该 License？绑定设备和店铺会一并删除，客户端立即失去该授权。',
      '永久删除 License',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await licensesApi.remove(license.id)
    ElMessage.success('License 已删除')
    await loadLicenses()
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, 'License 删除失败'))
  }
}
function maskedKey(value) {
  if (!value) return '—'
  const text = String(value)
  return text.length > 9 ? `${text.slice(0, 5)}••••${text.slice(-4)}` : text
}
onMounted(async () => { await Promise.all([loadUsers(), loadLicenses(), loadPlans()]) })
</script>

<template>
  <div class="page-stack">
    <page-header title="用户与授权" description="维护平台用户，并查看、授予或撤销其软件 License">
      <template #actions><el-button :icon="Plus" @click="openUser()">新增用户</el-button><el-button type="primary" :icon="Plus" :disabled="!users.length || !plans.length" @click="grantDialog = true">授予 License</el-button></template>
    </page-header>
    <el-card shadow="never" class="surface-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="用户管理" name="users">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-input v-model="userQuery.keyword" clearable placeholder="搜索注册邮箱或手机号" style="width:270px" @keyup.enter="loadUsers" /><el-select v-model="userQuery.status" clearable placeholder="全部状态" style="width:130px" @change="loadUsers"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select><el-button type="primary" @click="loadUsers">查询</el-button></div></div>
          <el-table v-loading="loading" :data="users" stripe><el-table-column label="用户" min-width="220"><template #default="{ row }"><div class="user-cell"><el-avatar :size="32">{{ userLabel(row).slice(0,1).toUpperCase() }}</el-avatar><div><strong>{{ userLabel(row) }}</strong><span>{{ row.is_admin ? '管理员' : '普通用户' }}</span></div></div></template></el-table-column><el-table-column prop="phone" label="手机号" min-width="130"><template #default="{ row }">{{ row.phone_masked || row.phone || '—' }}</template></el-table-column><el-table-column prop="email" label="注册邮箱" min-width="210"><template #default="{ row }">{{ row.email || '—' }}</template></el-table-column><el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column><el-table-column label="创建时间" width="170"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column><el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openUser(row)">编辑</el-button><el-button text type="danger" :icon="Delete" @click="removeUser(row)">删除</el-button></div></template></el-table-column><template #empty><el-empty description="暂无用户" /></template></el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="userQuery.page" v-model:page-size="userQuery.page_size" background layout="total, sizes, prev, pager, next" :total="userTotal" @change="loadUsers" /></div>
        </el-tab-pane>
        <el-tab-pane label="License 授权" name="licenses">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="licenseQuery.user_id" clearable filterable placeholder="全部用户" style="width:220px" @change="loadLicenses"><el-option v-for="item in users" :key="item.id" :label="userLabel(item)" :value="item.id" /></el-select><el-select v-model="licenseQuery.plan_id" clearable filterable placeholder="全部套餐" style="width:180px" @change="loadLicenses"><el-option v-for="item in plans" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-select v-model="licenseQuery.status" clearable placeholder="全部状态" style="width:130px" @change="loadLicenses"><el-option label="有效" value="active" /><el-option label="已暂停" value="suspended" /><el-option label="已撤销" value="revoked" /></el-select><el-button type="primary" @click="loadLicenses">刷新</el-button></div></div>
          <el-table v-loading="loading" :data="licenses" stripe><el-table-column label="用户" min-width="180"><template #default="{ row }">{{ row.user?.email || row.email || userMap.get(row.user_id) || row.user_id }}</template></el-table-column><el-table-column label="套餐" min-width="150"><template #default="{ row }">{{ row.plan?.name || row.plan_name || planMap.get(row.plan_id) || row.plan_id }}</template></el-table-column><el-table-column label="License Key" min-width="180"><template #default="{ row }"><span class="mono">{{ maskedKey(row.license_key) }}</span></template></el-table-column><el-table-column label="有效期" min-width="230"><template #default="{ row }"><span>{{ formatDateTime(row.start_time) }}<br /><span class="muted">至 {{ formatDateTime(row.expire_time) }}</span></span></template></el-table-column><el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column><el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button v-if="row.status !== 'revoked'" text type="warning" :icon="Remove" @click="revokeLicense(row)">撤销</el-button><el-button text type="danger" :icon="Delete" @click="removeLicense(row)">删除</el-button></div></template></el-table-column><template #empty><el-empty description="暂无授权" /></template></el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="licenseQuery.page" v-model:page-size="licenseQuery.page_size" background layout="total, sizes, prev, pager, next" :total="licenseTotal" @change="loadLicenses" /></div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <user-form-dialog v-model="userDialog" :user="editingUser" :submitting="submitting" @submit="saveUser" />
    <grant-license-dialog v-model="grantDialog" :users="users" :plans="plans" :submitting="submitting" @submit="grantLicense" />
  </div>
</template>

<style scoped>.tab-toolbar{min-height:44px;margin-bottom:15px}.user-cell{display:flex;align-items:center;gap:10px}.user-cell .el-avatar{color:#315efb;background:#edf2ff}.user-cell>div{display:flex;flex-direction:column;gap:3px}.user-cell span{color:var(--lc-muted);font-size:11px}</style>
