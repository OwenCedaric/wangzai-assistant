<script setup>
import { computed, ref, watch } from 'vue'
import { CopyDocument, Delete, Lock, Search, Unlock } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { cardBatchesApi } from '../../api/admin.js'
import { getApiError } from '../../api/response.js'
import { formatDateTime } from '../../utils/formatters.js'
import StatusBadge from '../common/StatusBadge.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  batch: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue'])

const loading = ref(false)
const codes = ref([])
const total = ref(0)
const page = ref(1)
const searchText = ref('')
const appliedSearch = ref('')
const pageSize = 20
const statusChangingId = ref(null)
const copyingCodeId = ref(null)
const copyingPage = ref(false)
const deletingCodeId = ref(null)
let loadSequence = 0

const dialogTitle = computed(() => (
  `卡密明细 · ${props.batch?.name || props.batch?.batch_no || props.batch?.id || ''}`
))
const copyablePageCodes = computed(() => codes.value.map(fullCode).filter(Boolean))

function fullCode(code) {
  return code?.card_key || code?.code || code?.license_key || ''
}

function displayedCode(code) {
  return fullCode(code) || `${code?.code_prefix || '••••-••••'}-••••-••••`
}

function boundShops(code) {
  return Array.isArray(code?.bound_shops) ? code.bound_shops : []
}

function isExpired(code) {
  if (!code.expires_at) return false
  const expiresAt = new Date(code.expires_at).getTime()
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

function canChangeStatus(code) {
  const unactivated = !code.activated_at && !code.activated_license_id && !code.activated_by_user_id
  return unactivated && !isExpired(code) && ['unused', 'disabled'].includes(code.status)
}

function clearSensitiveData({ resetPage = true } = {}) {
  loadSequence += 1
  loading.value = false
  codes.value = []
  statusChangingId.value = null
  copyingCodeId.value = null
  copyingPage.value = false
  deletingCodeId.value = null
  if (resetPage) {
    page.value = 1
    total.value = 0
    searchText.value = ''
    appliedSearch.value = ''
  }
}

async function loadCodes() {
  const batchId = props.batch?.id
  if (!props.modelValue || !batchId) return

  const sequence = ++loadSequence
  codes.value = []
  loading.value = true
  try {
    const pagination = {
      page: page.value,
      page_size: pageSize,
    }
    const result = appliedSearch.value
      ? await cardBatchesApi.searchRevealedCodes(batchId, {
        ...pagination,
        q: appliedSearch.value,
      })
      : await cardBatchesApi.revealedCodes(batchId, pagination)
    if (sequence !== loadSequence || !props.modelValue || props.batch?.id !== batchId) return
    codes.value = Array.isArray(result.items) ? result.items : []
    total.value = result.total || 0
  } catch (error) {
    if (sequence === loadSequence && props.modelValue) {
      ElMessage.error(getApiError(error, '卡密明细加载失败'))
    }
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchCodes() {
  const nextSearch = searchText.value.trim()
  searchText.value = nextSearch
  appliedSearch.value = nextSearch
  page.value = 1
  total.value = 0
  codes.value = []
  loadCodes()
}

function clearSearch() {
  searchText.value = ''
  appliedSearch.value = ''
  page.value = 1
  total.value = 0
  codes.value = []
  loadCodes()
}

function changePage(nextPage) {
  page.value = nextPage
  codes.value = []
  loadCodes()
}

async function writeClipboard(value) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable')
  await navigator.clipboard.writeText(value)
}

async function copyCode(code) {
  const value = fullCode(code)
  if (!value) return
  copyingCodeId.value = code.id
  try {
    await writeClipboard(value)
    ElMessage.success('卡密已复制')
  } catch {
    ElMessage.error('复制失败，请使用服务端导出')
  } finally {
    copyingCodeId.value = null
  }
}

async function copyPage() {
  if (!copyablePageCodes.value.length) return
  copyingPage.value = true
  try {
    await writeClipboard(copyablePageCodes.value.join('\n'))
    ElMessage.success(`已复制本页 ${copyablePageCodes.value.length} 个卡密`)
  } catch {
    ElMessage.error('复制失败，请使用服务端导出')
  } finally {
    copyingPage.value = false
  }
}

async function toggleCodeStatus(code) {
  const restoring = code.status === 'disabled'
  const nextStatus = restoring ? 'unused' : 'disabled'
  const action = restoring ? '恢复' : '禁用'
  try {
    await ElMessageBox.confirm(
      restoring ? '恢复后该卡密可再次用于激活，确定继续吗？' : '禁用后该卡密将无法用于激活，确定继续吗？',
      `${action}卡密`,
      {
        type: restoring ? 'info' : 'warning',
        confirmButtonText: `确认${action}`,
        cancelButtonText: '取消',
      },
    )
    statusChangingId.value = code.id
    await cardBatchesApi.updateCodeStatus(props.batch.id, code.id, nextStatus)
    ElMessage.success(`卡密已${action}`)
    await loadCodes()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(getApiError(error, `${action}卡密失败`))
    }
  } finally {
    statusChangingId.value = null
  }
}

async function removeCode(code) {
  try {
    await ElMessageBox.confirm(
      `永久删除卡密 ${displayedCode(code)}？已激活产生的 License 不会自动删除。`,
      '永久删除卡密',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    deletingCodeId.value = code.id
    await cardBatchesApi.removeCode(props.batch.id, code.id)
    ElMessage.success('卡密已删除')
    if (codes.value.length === 1 && page.value > 1) page.value -= 1
    await loadCodes()
  } catch (error) {
    if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '卡密删除失败'))
  } finally { deletingCodeId.value = null }
}

watch(
  [() => props.modelValue, () => props.batch?.id],
  ([visible, batchId], [previousVisible, previousBatchId] = []) => {
    if (!visible) {
      clearSensitiveData()
      return
    }
    if (!previousVisible || batchId !== previousBatchId) {
      clearSensitiveData()
      loadCodes()
    }
  },
  { immediate: true },
)
</script>

<template>
  <el-dialog
    class="batch-codes-dialog"
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(1320px, 96vw)"
    align-center
    destroy-on-close
    :draggable="false"
    :close-on-click-modal="false"
    @closed="clearSensitiveData()"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="dialog-toolbar">
      <div class="toolbar-summary">
        <strong>{{ total }}</strong>
        <span> 个卡密，完整卡密仅供管理员安全交付</span>
      </div>
      <div class="toolbar-actions">
        <div class="search-controls">
          <el-input
            v-model="searchText"
            class="search-input"
            clearable
            :maxlength="128"
            :prefix-icon="Search"
            placeholder="搜索完整卡密或前缀"
            aria-label="搜索完整卡密或前缀"
            @keyup.enter="searchCodes"
            @clear="clearSearch"
          />
          <el-button class="search-button" type="primary" @click="searchCodes">搜索</el-button>
        </div>
        <el-button
          class="copy-page-button"
          :icon="CopyDocument"
          :loading="copyingPage"
          :disabled="loading || !copyablePageCodes.length"
          @click="copyPage"
        >
          复制本页
        </el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="codes" stripe height="min(58vh, 560px)" table-layout="fixed">
      <el-table-column label="完整卡密" min-width="235">
        <template #default="{ row }">
          <div class="key-cell">
            <span class="mono key-text" :class="{ 'key-text--unavailable': !fullCode(row) }">
              {{ displayedCode(row) }}
            </span>
            <small v-if="!fullCode(row)">该卡密无法恢复</small>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="92">
        <template #default="{ row }"><status-badge :status="row.status" /></template>
      </el-table-column>
      <el-table-column label="使用信息" min-width="205">
        <template #default="{ row }">
          <div class="usage-cell">
            <span>用户 ID：{{ row.activated_by_user_id || '—' }}</span>
            <small>{{ row.activated_at || row.used_at ? formatDateTime(row.activated_at || row.used_at) : '尚未激活' }}</small>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="绑定店铺" min-width="270">
        <template #default="{ row }">
          <div v-if="boundShops(row).length" class="binding-list">
            <div v-for="shop in boundShops(row)" :key="shop.id || `${shop.platform}-${shop.shop_id}`" class="binding-item">
              <strong>{{ shop.shop_name || '未命名店铺' }}</strong>
              <span>{{ shop.platform === 'ozon' ? 'Ozon Client ID' : '平台店铺 ID' }}：{{ shop.shop_id }}</span>
            </div>
          </div>
          <span v-else class="muted">尚未绑定具体店铺</span>
        </template>
      </el-table-column>
      <el-table-column label="有效截止" width="158">
        <template #default="{ row }">{{ formatDateTime(row.activated_license_expire_at || row.expires_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="282">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button
              class="copy-code-button"
              text
              type="primary"
              :icon="CopyDocument"
              :loading="copyingCodeId === row.id"
              :disabled="!fullCode(row)"
              @click="copyCode(row)"
            >
              复制
            </el-button>
            <el-button
              v-if="canChangeStatus(row)"
              text
              :type="row.status === 'disabled' ? 'primary' : 'danger'"
              :icon="row.status === 'disabled' ? Unlock : Lock"
              :loading="statusChangingId === row.id"
              @click="toggleCodeStatus(row)"
            >
              {{ row.status === 'disabled' ? '恢复' : '禁用' }}
            </el-button>
            <el-button
              text
              type="danger"
              :icon="Delete"
              :loading="deletingCodeId === row.id"
              @click="removeCode(row)"
            >
              删除
            </el-button>
          </div>
        </template>
      </el-table-column>
      <template #empty><el-empty description="暂无卡密明细" /></template>
    </el-table>

    <template #footer>
      <div class="dialog-footer">
        <el-pagination
          :current-page="page"
          :page-size="pageSize"
          background
          layout="total, prev, pager, next"
          :total="total"
          @current-change="changePage"
        />
        <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-toolbar{display:flex;min-width:0;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;color:var(--lc-muted);font-size:13px}.dialog-toolbar strong{color:#172033;font-size:18px}.toolbar-summary{flex:1 1 auto;min-width:230px}.toolbar-actions,.search-controls{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:10px}.toolbar-actions{flex:0 1 auto}.search-controls{flex:1 1 330px;min-width:250px}.search-input{width:min(330px,28vw)}.copy-page-button{flex:none}.key-cell,.usage-cell,.binding-list,.binding-item{display:flex;flex-direction:column;gap:4px;min-width:0}.binding-list{gap:8px}.binding-item{padding:7px 9px;border:1px solid var(--lc-border);border-radius:6px;background:#f8faff}.binding-item strong{overflow:hidden;color:#172033;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.binding-item span{color:var(--lc-muted);font-family:var(--lc-font-mono);font-size:11px}.muted{color:var(--lc-muted);font-size:12px}.key-text{color:#172033;font-size:13px;letter-spacing:.15px;white-space:nowrap}.key-text--unavailable{color:var(--lc-muted)}.key-cell small,.usage-cell small{color:var(--lc-muted);font-size:11px}.row-actions{display:flex;min-width:max-content;flex-wrap:nowrap;align-items:center;gap:8px;white-space:nowrap}.row-actions>*{flex:0 0 auto}.row-actions .el-button+.el-button{margin-left:0}.dialog-footer{display:flex;min-width:0;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:18px}@media(max-width:900px){.dialog-toolbar{align-items:stretch;flex-direction:column}.toolbar-actions{justify-content:space-between}.search-input{width:100%}}@media(max-width:720px){.toolbar-actions,.search-controls,.dialog-footer{align-items:stretch;flex-direction:column}.search-controls{flex-basis:auto;min-width:0}.search-button,.copy-page-button{width:100%}.dialog-footer .el-button{align-self:flex-end;width:auto}}
</style>
