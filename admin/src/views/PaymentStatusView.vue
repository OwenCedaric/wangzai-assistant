<script setup>
import { computed, onMounted, ref } from 'vue'
import { CircleCheck, CircleClose, RefreshRight } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { paymentConfigApi } from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import { paymentProviderLabel } from '../utils/commerce.js'

const loading = ref(false)
const data = ref({ providers: [] })
const providers = computed(() => Array.isArray(data.value.providers) ? data.value.providers : [])
const readyCount = computed(() => providers.value.filter((item) => item.configured && item.enabled).length)

async function loadStatus() {
  loading.value = true
  try { data.value = await paymentConfigApi.status() || { providers: [] } }
  catch (error) { ElMessage.error(getApiError(error, '支付配置状态加载失败')) } finally { loading.value = false }
}
onMounted(loadStatus)
</script>

<template>
  <div v-loading="loading" class="page-stack">
    <page-header title="支付与短信配置" description="只读检查服务器支付、短信能力是否就绪；管理端永不读取或展示密钥原文">
      <template #actions><el-button :icon="RefreshRight" :loading="loading" @click="loadStatus">重新检测</el-button></template>
    </page-header>
    <el-alert v-if="providers.length && readyCount === 0" title="当前没有可用的真实支付通道" description="可先使用开发环境模拟支付完成业务联调，上服务器后再配置商户证书与公网 HTTPS 回调。" type="warning" :closable="false" show-icon />
    <section class="health-summary">
      <el-card shadow="never" class="surface-card summary-card"><span>默认支付通道</span><strong>{{ paymentProviderLabel(data.default_provider) }}</strong><small>由服务器环境变量控制</small></el-card>
      <el-card shadow="never" class="surface-card summary-card"><span>可用支付通道</span><strong>{{ readyCount }} / {{ providers.length }}</strong><small>已配置且已启用</small></el-card>
      <el-card shadow="never" class="surface-card summary-card"><span>短信验证码</span><strong>{{ data.sms_configured ? '已就绪' : '未就绪' }}</strong><small>{{ data.sms_provider || '未选择服务商' }}</small></el-card>
    </section>
    <el-card shadow="never" class="surface-card">
      <template #header><div class="card-heading"><div><strong>支付通道健康状态</strong><span>这里只展示布尔状态和服务端诊断，不返回 App Secret、私钥或证书内容</span></div></div></template>
      <div v-if="providers.length" class="provider-grid">
        <article v-for="provider in providers" :key="provider.provider" class="provider-card">
          <div class="provider-card__top"><div class="provider-icon" :class="{ ready: provider.configured && provider.enabled }"><el-icon><CircleCheck v-if="provider.configured && provider.enabled" /><CircleClose v-else /></el-icon></div><status-badge :status="provider.enabled ? 'enabled' : 'disabled'" context="config" /></div>
          <h2>{{ paymentProviderLabel(provider.provider) }}</h2>
          <div class="check-row"><span>商户配置</span><strong :class="provider.configured ? 'ok' : 'bad'">{{ provider.configured ? '完整' : '缺失' }}</strong></div>
          <div class="check-row"><span>服务开关</span><strong :class="provider.enabled ? 'ok' : 'muted'">{{ provider.enabled ? '开启' : '关闭' }}</strong></div>
          <p v-if="provider.reason">{{ provider.reason }}</p>
        </article>
      </div>
      <el-empty v-else description="服务端尚未返回支付通道配置" />
    </el-card>
    <el-card shadow="never" class="surface-card deployment-card">
      <div><strong>服务器上线检查</strong><span>公网 HTTPS 域名 → 支付平台回调验签 → 主动查单 → 支付履约 → 退款与佣金冲销</span></div>
      <el-tag type="info" effect="plain">配置修改请在服务器完成</el-tag>
    </el-card>
  </div>
</template>

<style scoped>
.health-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.summary-card span{color:var(--lc-muted);font-size:13px}.summary-card strong{display:block;margin-top:14px;font-size:25px}.summary-card small{display:block;margin-top:7px;color:#929bad}.card-heading>div{display:flex;flex-direction:column;gap:5px}.card-heading span{color:var(--lc-muted);font-size:12px}.provider-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.provider-card{padding:18px;border:1px solid var(--lc-border);border-radius:12px;background:#fafbfe}.provider-card__top{display:flex;align-items:center;justify-content:space-between}.provider-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:10px;color:#d64d5c;background:#ffedf0}.provider-icon.ready{color:#168766;background:#e8f7f1}.provider-card h2{margin:15px 0;font-size:17px}.check-row{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid #edf0f5;font-size:13px}.ok{color:#168766}.bad{color:#d64d5c}.provider-card p{margin:10px 0 0;color:var(--lc-muted);font-size:12px;line-height:1.6}.deployment-card :deep(.el-card__body){display:flex;align-items:center;justify-content:space-between;gap:18px}.deployment-card div{display:flex;flex-direction:column;gap:7px}.deployment-card span{color:var(--lc-muted);font-size:12px;line-height:1.6}
@media(max-width:980px){.provider-grid,.health-summary{grid-template-columns:1fr}}@media(max-width:620px){.deployment-card :deep(.el-card__body){align-items:flex-start;flex-direction:column}}
</style>
