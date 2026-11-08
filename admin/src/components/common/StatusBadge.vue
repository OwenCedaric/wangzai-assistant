<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: [String, Boolean], default: '' },
  context: { type: String, default: '' },
})

const statusMap = {
  active: ['正常', 'success'], enabled: ['已启用', 'success'], valid: ['有效', 'success'],
  online: ['在线', 'success'], activated: ['已激活', 'success'], paid: ['付费', 'success'],
  unused: ['未使用', 'primary'], pending: ['待处理', 'warning'], expiring: ['即将到期', 'warning'],
  expired: ['已到期', 'danger'], disabled: ['已禁用', 'info'], inactive: ['已停用', 'info'],
  suspended: ['已暂停', 'warning'], completed: ['已完成', 'success'],
  revoked: ['已撤销', 'danger'], banned: ['已封禁', 'danger'], offline: ['离线', 'info'],
  paying: ['支付中', 'warning'], fulfilled: ['已履约', 'success'], closed: ['已关闭', 'info'],
  refunding: ['退款中', 'warning'], refunded: ['已退款', 'info'], failed: ['失败', 'danger'],
  available: ['可结算', 'primary'], settled: ['已结算', 'success'], reversed: ['已冲销', 'danger'],
  configured: ['已配置', 'success'], unconfigured: ['未配置', 'warning'],
}

const normalized = computed(() => {
  if (props.status === true) return 'active'
  if (props.status === false) return 'disabled'
  return String(props.status || '').toLowerCase()
})
const contextMap = {
  order: { pending: ['待支付', 'warning'], paid: ['已支付', 'success'] },
  commission: { pending: ['待结算', 'warning'] },
  config: { enabled: ['已启用', 'success'], disabled: ['未启用', 'info'] },
}
const info = computed(() => contextMap[props.context]?.[normalized.value] || statusMap[normalized.value] || [String(props.status || '未知'), 'info'])
</script>

<template>
  <el-tag :type="info[1]" effect="light" round>{{ info[0] }}</el-tag>
</template>
