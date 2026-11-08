<script setup>
import { onMounted, reactive, ref } from 'vue'
import { Delete, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getApiError } from '../../api/response.js'
import { formatDateTime } from '../../utils/formatters.js'
import StatusBadge from './StatusBadge.vue'

const props = defineProps({
  load: { type: Function, required: true },
  columns: { type: Array, required: true },
  searchPlaceholder: { type: String, default: '搜索关键词' },
  searchParam: { type: String, default: 'q' },
  showSearch: { type: Boolean, default: true },
  statusOptions: { type: Array, default: () => [] },
  selectParam: { type: String, default: 'status' },
  selectPlaceholder: { type: String, default: '全部状态' },
  extraParams: { type: Object, default: () => ({}) },
  remove: { type: Function, default: null },
  deleteTitle: { type: String, default: '永久删除记录' },
  deleteMessage: { type: [String, Function], default: '删除后无法恢复，确定继续吗？' },
})

const loading = ref(false)
const rows = ref([])
const total = ref(0)
const deletingId = ref(null)
const query = reactive({ keyword: '', status: '', page: 1, page_size: 20 })

function cellValue(row, column) {
  const value = column.prop.split('.').reduce((current, key) => current?.[key], row)
  if (column.type === 'date') return formatDateTime(value)
  if (column.type === 'array') return Array.isArray(value) ? value.join('、') : value || '—'
  if (column.type === 'json') return value && typeof value === 'object' ? JSON.stringify(value) : value || '—'
  return value ?? '—'
}

async function fetchRows() {
  loading.value = true
  try {
    const params = { ...props.extraParams, page: query.page, page_size: query.page_size }
    if (query.keyword && props.searchParam) params[props.searchParam] = query.keyword
    if (query.status && props.selectParam) params[props.selectParam] = query.status
    const result = await props.load(params)
    rows.value = result.items
    total.value = result.total
  } catch (error) {
    ElMessage.error(getApiError(error, '列表加载失败'))
  } finally {
    loading.value = false
  }
}

function search() {
  query.page = 1
  fetchRows()
}

function reset() {
  query.keyword = ''
  query.status = ''
  query.page = 1
  fetchRows()
}

async function removeRow(row) {
  if (!props.remove) return
  const message = typeof props.deleteMessage === 'function'
    ? props.deleteMessage(row)
    : props.deleteMessage
  try {
    await ElMessageBox.confirm(message, props.deleteTitle, {
      type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消',
    })
    deletingId.value = row.id
    await props.remove(row.id)
    ElMessage.success('记录已删除')
    if (rows.value.length === 1 && query.page > 1) query.page -= 1
    await fetchRows()
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) {
      ElMessage.error(getApiError(error, '记录删除失败'))
    }
  } finally {
    deletingId.value = null
  }
}

defineExpose({ refresh: fetchRows })
onMounted(fetchRows)
</script>

<template>
  <el-card shadow="never" class="surface-card">
    <div class="toolbar list-toolbar">
      <div class="toolbar__filters">
        <el-input
          v-if="showSearch"
          v-model="query.keyword"
          clearable
          :prefix-icon="Search"
          :placeholder="searchPlaceholder"
          style="width: 260px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select
          v-if="statusOptions.length"
          v-model="query.status"
          clearable
          :placeholder="selectPlaceholder"
          style="width: 150px"
          @change="search"
        >
          <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
      <slot name="actions" :refresh="fetchRows" />
    </div>

    <el-table v-loading="loading" :data="rows" stripe class="data-table">
      <el-table-column
        v-for="column in columns"
        :key="column.prop"
        :label="column.label"
        :min-width="column.minWidth || 120"
        :width="column.width"
        :fixed="column.fixed"
        show-overflow-tooltip
      >
        <template #default="scope">
          <status-badge v-if="column.type === 'status'" :status="cellValue(scope.row, column)" />
          <span v-else :class="{ mono: column.type === 'mono' }">{{ cellValue(scope.row, column) }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="remove" label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button
            text
            type="danger"
            :icon="Delete"
            :loading="deletingId === row.id"
            @click="removeRow(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无数据" />
      </template>
    </el-table>

    <div class="table-pagination">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.page_size"
        background
        layout="total, sizes, prev, pager, next"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        @change="fetchRows"
      />
    </div>
  </el-card>
</template>

<style scoped>
.list-toolbar { margin-bottom: 18px; }
.data-table { width: 100%; }
</style>
