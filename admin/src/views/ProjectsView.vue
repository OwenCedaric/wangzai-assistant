<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { productsApi, projectsApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import ProductFormDialog from '../components/projects/ProductFormDialog.vue'
import ProjectFormDialog from '../components/projects/ProjectFormDialog.vue'
import ProjectImportDialog from '../components/projects/ProjectImportDialog.vue'

const activeTab = ref('projects')
const loading = ref(false)
const submitting = ref(false)
const projects = ref([])
const products = ref([])
const projectTotal = ref(0)
const productTotal = ref(0)
const projectQuery = reactive({ keyword: '', status: '', page: 1, page_size: 20 })
const productQuery = reactive({ project_id: '', page: 1, page_size: 20 })
const projectDialog = ref(false)
const importDialog = ref(false)
const productDialog = ref(false)
const editingProject = ref(null)
const editingProduct = ref(null)
const projectNameMap = computed(() => new Map(projects.value.map((item) => [item.id, item.name])))

async function loadProjects() {
  loading.value = true
  try {
    const result = await projectsApi.list(projectQuery)
    projects.value = result.items
    projectTotal.value = result.total
  } catch (error) { ElMessage.error(getApiError(error, '项目列表加载失败')) } finally { loading.value = false }
}

async function loadProducts() {
  loading.value = true
  try {
    const result = await productsApi.list(productQuery)
    products.value = result.items
    productTotal.value = result.total
  } catch (error) { ElMessage.error(getApiError(error, '产品列表加载失败')) } finally { loading.value = false }
}

function openProject(project = null) { editingProject.value = project; projectDialog.value = true }
function openProduct(product = null) { editingProduct.value = product; productDialog.value = true }

async function saveProject(payload) {
  submitting.value = true
  try {
    if (editingProject.value) await projectsApi.update(editingProject.value.id, payload)
    else await projectsApi.create(payload)
    ElMessage.success(editingProject.value ? '项目已更新' : '项目已创建')
    projectDialog.value = false
    await loadProjects()
  } catch (error) { ElMessage.error(getApiError(error, '项目保存失败')) } finally { submitting.value = false }
}

async function saveProduct(payload) {
  submitting.value = true
  try {
    if (editingProduct.value) await productsApi.update(editingProduct.value.id, payload)
    else await productsApi.create(payload)
    ElMessage.success(editingProduct.value ? '产品版本已更新' : '产品版本已创建')
    productDialog.value = false
    await loadProducts()
  } catch (error) { ElMessage.error(getApiError(error, '产品保存失败')) } finally { submitting.value = false }
}

async function importProject(manifest) {
  submitting.value = true
  try {
    await projectsApi.importManifest(manifest)
    ElMessage.success('project.json 导入成功')
    importDialog.value = false
    await loadProjects()
  } catch (error) { ElMessage.error(getApiError(error, '项目导入失败')) } finally { submitting.value = false }
}

async function removeProject(project) {
  try {
    await ElMessageBox.confirm(`删除项目“${project.name}”？仅无关联数据时可以删除。`, '删除项目', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await projectsApi.remove(project.id); ElMessage.success('项目已删除'); loadProjects()
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, '项目删除失败')) }
}

async function removeProduct(product) {
  try {
    await ElMessageBox.confirm(`删除产品版本“${product.name} ${product.version}”？`, '删除产品', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    await productsApi.remove(product.id); ElMessage.success('产品已删除'); loadProducts()
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, '产品删除失败')) }
}

onMounted(async () => { await loadProjects(); await loadProducts() })
</script>

<template>
  <div class="page-stack">
    <page-header title="项目管理" description="使用标准 project.json 接入软件项目，并维护项目下的产品版本">
      <template #actions><el-button :icon="Upload" @click="importDialog = true">导入 project.json</el-button><el-button type="primary" :icon="Plus" @click="openProject()">新增项目</el-button></template>
    </page-header>
    <el-card shadow="never" class="surface-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="软件项目" name="projects">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-input v-model="projectQuery.keyword" clearable placeholder="搜索名称或项目代码" style="width:260px" @keyup.enter="loadProjects" /><el-select v-model="projectQuery.status" clearable placeholder="全部状态" style="width:140px" @change="loadProjects"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select><el-button type="primary" @click="loadProjects">查询</el-button></div></div>
          <el-table v-loading="loading" :data="projects" stripe>
            <el-table-column label="项目" min-width="190"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.name }}</strong><span>{{ row.description || '暂无说明' }}</span></div></template></el-table-column>
            <el-table-column prop="code" label="项目代码" min-width="150"><template #default="{ row }"><span class="mono code-pill">{{ row.code }}</span></template></el-table-column>
            <el-table-column prop="version" label="当前版本" width="120" />
            <el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openProject(row)">编辑</el-button><el-button text type="danger" :icon="Delete" @click="removeProject(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无软件项目" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="projectQuery.page" v-model:page-size="projectQuery.page_size" background layout="total, sizes, prev, pager, next" :total="projectTotal" @change="loadProjects" /></div>
        </el-tab-pane>
        <el-tab-pane label="产品版本" name="products">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="productQuery.project_id" clearable filterable placeholder="全部软件项目" style="width:250px" @change="loadProducts"><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="primary" @click="loadProducts">刷新</el-button></div><el-button type="primary" :icon="Plus" :disabled="!projects.length" @click="openProduct()">新增产品版本</el-button></div>
          <el-table v-loading="loading" :data="products" stripe>
            <el-table-column prop="name" label="产品名称" min-width="180" />
            <el-table-column label="所属项目" min-width="180"><template #default="{ row }">{{ row.project?.name || projectNameMap.get(row.project_id) || row.project_id }}</template></el-table-column>
            <el-table-column prop="version" label="版本" min-width="120" />
            <el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openProduct(row)">编辑</el-button><el-button text type="danger" :icon="Delete" @click="removeProduct(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无产品版本" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="productQuery.page" v-model:page-size="productQuery.page_size" background layout="total, sizes, prev, pager, next" :total="productTotal" @change="loadProducts" /></div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <project-form-dialog v-model="projectDialog" :project="editingProject" :submitting="submitting" @submit="saveProject" />
    <product-form-dialog v-model="productDialog" :product="editingProduct" :projects="projects" :submitting="submitting" @submit="saveProduct" />
    <project-import-dialog v-model="importDialog" :submitting="submitting" @submit="importProject" />
  </div>
</template>

<style scoped>
.tab-toolbar { min-height: 44px; margin-bottom: 15px; }.primary-cell { display:flex; flex-direction:column; gap:5px; }.primary-cell strong{font-size:14px}.primary-cell span{max-width:360px;color:var(--lc-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.code-pill{padding:5px 8px;border-radius:6px;color:#315efb;background:#f0f4ff;font-size:12px}
</style>
