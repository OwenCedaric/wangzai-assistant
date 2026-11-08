<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Connection, RefreshRight, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { ossManagementApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const configuration = ref({ configured: false, status: 'unconfigured' })
const usage = ref(null)
const hours = ref(168)
const form = reactive({
  name: '旺崽商品图片 OSS',
  region: 'oss-cn-hongkong',
  bucket: '',
  endpoint: 'https://oss-cn-hongkong.aliyuncs.com',
  accelerate_endpoint: 'https://oss-accelerate.aliyuncs.com',
  acceleration_enabled: true,
  access_key_id: '',
  access_key_secret: '',
  object_access_key_id: '',
  object_access_key_secret: '',
  storage_price_cny_per_gb_month: 0.136,
  network_out_price_cny_per_gb: 0.75,
  acceleration_price_cny_per_gb: 1.25,
})

const statusLabel = computed(() => ({
  active: '连接正常', pending: '等待验证', invalid: '验证失败', unconfigured: '尚未配置',
})[configuration.value.status] || configuration.value.status)
const statusType = computed(() => ({
  active: 'success', pending: 'warning', invalid: 'danger', unconfigured: 'info',
})[configuration.value.status] || 'info')
const recentPoints = computed(() => [...(usage.value?.points || [])].reverse().slice(0, 48))

function formatBytes(value) {
  let number = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index += 1 }
  return `${number.toFixed(index < 2 ? 0 : 2)} ${units[index]}`
}
function formatInteger(value) { return Number(value || 0).toLocaleString('zh-CN') }
function formatMoney(value) { return `¥${Number(value || 0).toFixed(2)}` }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未读取' }

function applyConfiguration(value) {
  configuration.value = value
  if (!value.configured) return
  for (const key of [
    'name', 'region', 'bucket', 'endpoint', 'accelerate_endpoint', 'acceleration_enabled',
    'storage_price_cny_per_gb_month', 'network_out_price_cny_per_gb',
    'acceleration_price_cny_per_gb',
  ]) {
    if (value[key] !== undefined && value[key] !== null) form[key] = value[key]
  }
  form.access_key_id = ''
  form.access_key_secret = ''
  form.object_access_key_id = ''
  form.object_access_key_secret = ''
}

async function loadConfiguration() {
  applyConfiguration(await ossManagementApi.configuration())
}
async function loadUsage() {
  if (!configuration.value.configured) { usage.value = null; return }
  usage.value = await ossManagementApi.usage(hours.value)
  configuration.value = await ossManagementApi.configuration()
}
async function reload() {
  loading.value = true
  try { await loadConfiguration(); await loadUsage() }
  catch (error) { ElMessage.error(getApiError(error, 'OSS用量读取失败')) }
  finally { loading.value = false }
}
async function save() {
  if (!form.bucket.trim()) { ElMessage.error('请填写Bucket名称'); return }
  const payload = {
    ...form,
    access_key_id: form.access_key_id.trim() || null,
    access_key_secret: form.access_key_secret.trim() || null,
    object_access_key_id: form.object_access_key_id.trim() || null,
    object_access_key_secret: form.object_access_key_secret.trim() || null,
  }
  saving.value = true
  try {
    applyConfiguration(await ossManagementApi.saveConfiguration(payload))
    ElMessage.success('OSS配置已加密保存，请点击“验证连接”')
  } catch (error) { ElMessage.error(getApiError(error, 'OSS配置保存失败')) }
  finally { saving.value = false }
}
async function verify() {
  testing.value = true
  try {
    applyConfiguration(await ossManagementApi.test())
    ElMessage.success('OSS用量及统一图片读写权限验证成功')
    await loadUsage()
  } catch (error) { ElMessage.error(getApiError(error, 'OSS连接验证失败')) }
  finally { testing.value = false }
}

onMounted(reload)
</script>

<template>
  <div class="page-stack">
    <page-header title="OSS 管理" description="集中配置阿里云OSS地址，并查看存储、流量、加速和请求用量">
      <template #actions>
        <el-select v-model="hours" style="width: 140px" @change="loadUsage">
          <el-option label="最近24小时" :value="24" />
          <el-option label="最近7天" :value="168" />
          <el-option label="最近30天" :value="720" />
          <el-option label="最近90天" :value="2160" />
        </el-select>
        <el-button :icon="RefreshRight" :loading="loading" @click="reload">刷新用量</el-button>
      </template>
    </page-header>

    <el-alert
      title="所有用户、所有店铺共用这一套管理端OSS；AccessKey只在管理后端加密保存，永不下发桌面端。"
      type="info" :closable="false" show-icon
    />

    <div class="metric-grid oss-metrics">
      <el-card shadow="never" class="metric-card"><span>当前存储</span><strong>{{ formatBytes(usage?.current_storage_bytes) }}</strong><small>月存储估算 {{ formatMoney(usage?.estimated_storage_monthly_cny) }}</small></el-card>
      <el-card shadow="never" class="metric-card"><span>外网流出</span><strong>{{ formatBytes(usage?.network_out_bytes) }}</strong><small>当前周期估算 {{ formatMoney(usage?.estimated_period_network_out_cny) }}</small></el-card>
      <el-card shadow="never" class="metric-card"><span>传输加速</span><strong>{{ formatBytes((usage?.acceleration_in_bytes || 0) + (usage?.acceleration_out_bytes || 0)) }}</strong><small>当前周期估算 {{ formatMoney(usage?.estimated_period_acceleration_cny) }}</small></el-card>
      <el-card shadow="never" class="metric-card"><span>GET / PUT</span><strong>{{ formatInteger(usage?.get_requests) }} / {{ formatInteger(usage?.put_requests) }}</strong><small>图片处理 {{ formatBytes(usage?.image_process_bytes) }}</small></el-card>
    </div>

    <div class="oss-layout">
      <el-card shadow="never" class="surface-card">
        <template #header>
          <div class="card-header">
            <div><strong>阿里云OSS连接</strong><span>完整AccessKey只在后端加密保存，不返回页面和日志</span></div>
            <el-tag :type="statusType" effect="plain">{{ statusLabel }}</el-tag>
            <el-tag v-if="configuration.runtime_revision" type="info" effect="plain">运行配置 v{{ configuration.runtime_revision }}</el-tag>
          </div>
        </template>
        <el-form label-position="top" class="oss-form">
          <div class="form-grid">
            <el-form-item label="配置名称"><el-input v-model="form.name" /></el-form-item>
            <el-form-item label="地域"><el-input v-model="form.region" placeholder="oss-cn-hongkong" /></el-form-item>
            <el-form-item label="Bucket"><el-input v-model="form.bucket" placeholder="wangzai-images" /></el-form-item>
            <el-form-item label="区域Endpoint"><el-input v-model="form.endpoint" /></el-form-item>
            <el-form-item label="传输加速Endpoint"><el-input v-model="form.accelerate_endpoint" :disabled="!form.acceleration_enabled" /></el-form-item>
            <el-form-item label="传输加速"><el-switch v-model="form.acceleration_enabled" active-text="启用" inactive-text="停用" /></el-form-item>
          </div>
          <el-divider content-position="left">管理端统一RAM凭证</el-divider>
          <el-alert title="该RAM账号需具备用量读取权限，以及当前Bucket下 wangzai/* 的 PutObject、GetObject、DeleteObject 权限。留空表示保留服务器现有密钥。" type="info" :closable="false" show-icon />
          <div class="form-grid key-grid">
            <el-form-item label="AccessKey ID">
              <el-input v-model="form.access_key_id" autocomplete="new-password" :placeholder="configuration.masked_access_key_id || '输入管理端AccessKey ID'" />
            </el-form-item>
            <el-form-item label="AccessKey Secret">
              <el-input v-model="form.access_key_secret" type="password" show-password autocomplete="new-password" placeholder="输入后加密保存" />
            </el-form-item>
          </div>
          <el-divider content-position="left">统一图片读写RAM凭证</el-divider>
          <el-alert title="只保存在管理端，供所有用户和所有店铺统一上传临时参考图；客户端和普通用户无法读取。" type="info" :closable="false" show-icon />
          <div class="form-grid key-grid">
            <el-form-item label="图片读写 AccessKey ID">
              <el-input v-model="form.object_access_key_id" autocomplete="new-password" :placeholder="configuration.masked_object_access_key_id || '输入图片读写AccessKey ID'" />
            </el-form-item>
            <el-form-item label="图片读写 AccessKey Secret">
              <el-input v-model="form.object_access_key_secret" type="password" show-password autocomplete="new-password" placeholder="输入后仅在管理端加密保存" />
            </el-form-item>
          </div>
          <el-divider content-position="left">目录价估算</el-divider>
          <div class="form-grid price-grid">
            <el-form-item label="存储 元/GB/月"><el-input-number v-model="form.storage_price_cny_per_gb_month" :min="0" :precision="6" :step="0.001" /></el-form-item>
            <el-form-item label="外网流出 元/GB"><el-input-number v-model="form.network_out_price_cny_per_gb" :min="0" :precision="6" :step="0.01" /></el-form-item>
            <el-form-item label="传输加速 元/GB"><el-input-number v-model="form.acceleration_price_cny_per_gb" :min="0" :precision="6" :step="0.01" /></el-form-item>
          </div>
          <div class="form-actions">
            <el-button type="primary" :icon="UploadFilled" :loading="saving" @click="save">保存配置</el-button>
            <el-button :icon="Connection" :loading="testing" :disabled="!configuration.configured" @click="verify">验证连接</el-button>
            <span class="muted">最近验证：{{ formatTime(configuration.last_verified_at) }}</span>
          </div>
        </el-form>
      </el-card>

      <el-card shadow="never" class="surface-card usage-card">
        <template #header><div class="card-header"><div><strong>小时用量</strong><span>{{ usage?.data_delay_note || '保存并验证配置后读取' }}</span></div><strong>{{ formatMoney(usage?.estimated_total_cny) }}</strong></div></template>
        <el-table v-loading="loading" :data="recentPoints" height="620" stripe>
          <el-table-column label="时间" min-width="165"><template #default="{ row }">{{ formatTime(row.start_time) }}</template></el-table-column>
          <el-table-column label="存储" width="100"><template #default="{ row }">{{ formatBytes(row.storage_bytes) }}</template></el-table-column>
          <el-table-column label="外网流出" width="105"><template #default="{ row }">{{ formatBytes(row.network_out_bytes) }}</template></el-table-column>
          <el-table-column label="加速" width="100"><template #default="{ row }">{{ formatBytes(row.acceleration_in_bytes + row.acceleration_out_bytes) }}</template></el-table-column>
          <el-table-column label="GET" width="90"><template #default="{ row }">{{ formatInteger(row.get_requests) }}</template></el-table-column>
          <el-table-column label="PUT" width="90"><template #default="{ row }">{{ formatInteger(row.put_requests) }}</template></el-table-column>
          <template #empty><el-empty description="暂无OSS小时用量" /></template>
        </el-table>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.oss-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.oss-layout { display: grid; grid-template-columns: minmax(420px, .9fr) minmax(560px, 1.1fr); gap: 18px; align-items: start; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.card-header > div { display: grid; gap: 4px; }
.card-header span, .muted { color: var(--el-text-color-secondary); font-size: 13px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.price-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.form-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
@media (max-width: 1180px) { .oss-layout { grid-template-columns: 1fr; } .oss-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .form-grid, .price-grid, .oss-metrics { grid-template-columns: 1fr; } }
</style>
