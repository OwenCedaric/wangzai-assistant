<script setup>
import { computed } from 'vue'
import { RefreshRight, RefreshLeft } from '@element-plus/icons-vue'
import { formatCentAmount, formatDateTime } from '../../utils/formatters.js'
import { fulfillmentLabel, paymentProviderLabel } from '../../utils/commerce.js'
import StatusBadge from '../common/StatusBadge.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  order: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  querying: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'query', 'refund'])
const drawerSize = computed(() => window.innerWidth < 680 ? '94%' : '620px')
const refundable = computed(() => ['paid', 'fulfilled'].includes(props.order?.status))
</script>

<template>
  <el-drawer :model-value="modelValue" :size="drawerSize" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <template #header><div class="drawer-heading"><div><strong>订单详情</strong><span class="mono">{{ order?.order_no }}</span></div><status-badge v-if="order" :status="order.status" context="order" /></div></template>
    <div v-loading="loading">
      <el-alert v-if="order?.status === 'paid' && !order?.fulfilled_at" title="支付已确认，正在等待授权履约" type="warning" :closable="false" show-icon />
      <el-descriptions v-if="order" :column="1" border class="details">
        <el-descriptions-item label="订单编号"><span class="mono">{{ order.order_no }}</span></el-descriptions-item>
        <el-descriptions-item label="订单金额"><strong>{{ formatCentAmount(order.amount_cent, order.currency) }}</strong></el-descriptions-item>
        <el-descriptions-item label="套餐快照">{{ order.plan_name_snapshot || `套餐 #${order.plan_id}` }}</el-descriptions-item>
        <el-descriptions-item label="用户 / 项目">用户 #{{ order.user_id }} · 项目 #{{ order.project_id }}</el-descriptions-item>
        <el-descriptions-item label="代理 / 渠道">{{ order.agent_id ? `代理 #${order.agent_id}` : '自然注册' }}<span v-if="order.channel_id"> · 渠道 #{{ order.channel_id }}</span></el-descriptions-item>
        <el-descriptions-item label="支付渠道">{{ paymentProviderLabel(order.payment_provider) }}</el-descriptions-item>
        <el-descriptions-item label="支付交易号"><span class="mono">{{ order.provider_payment_no || '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="履约状态">{{ fulfillmentLabel(order) }}</el-descriptions-item>
        <el-descriptions-item label="激活码标识"><span class="mono">{{ order.activation_code_prefix || '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="创建 / 过期">{{ formatDateTime(order.created_at) }}<br /><span class="muted">{{ formatDateTime(order.expires_at) }}</span></el-descriptions-item>
        <el-descriptions-item label="支付时间">{{ formatDateTime(order.paid_at) }}</el-descriptions-item>
        <el-descriptions-item label="履约时间">{{ formatDateTime(order.fulfilled_at) }}</el-descriptions-item>
        <el-descriptions-item v-if="order.refunded_at" label="退款时间">{{ formatDateTime(order.refunded_at) }}</el-descriptions-item>
      </el-descriptions>
    </div>
    <template #footer>
      <div class="drawer-actions"><el-button :icon="RefreshRight" :loading="querying" @click="emit('query')">主动查单</el-button><el-button v-if="refundable" type="danger" plain :icon="RefreshLeft" @click="emit('refund')">发起退款</el-button></div>
    </template>
  </el-drawer>
</template>

<style scoped>
.drawer-heading{display:flex;min-width:0;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;width:100%}.drawer-heading>div{display:flex;min-width:0;flex-direction:column;gap:5px}.drawer-heading span{color:var(--lc-muted);font-size:12px;overflow-wrap:anywhere}.details{margin-top:16px}.drawer-actions{display:flex;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:10px}.drawer-actions>*{flex:0 0 auto}
</style>
