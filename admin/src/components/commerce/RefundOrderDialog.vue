<script setup>
import { reactive, ref, watch } from 'vue'
import { formatCentAmount, yuanToCent } from '../../utils/formatters.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  order: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ amount_yuan: null, reason: '' })

function validateAmount(rule, value, callback) {
  if (value === '' || value === null || value === undefined) return callback()
  const cents = yuanToCent(value)
  if (!cents || cents <= 0) return callback(new Error('退款金额必须大于 0'))
  if (cents > Number(props.order?.amount_cent || 0)) return callback(new Error('退款金额不能超过订单金额'))
  callback()
}
const rules = {
  amount_yuan: [{ validator: validateAmount, trigger: 'blur' }],
  reason: [
    { required: true, message: '请填写退款原因', trigger: 'blur' },
    { min: 2, max: 200, message: '退款原因需为 2 至 200 个字符', trigger: 'blur' },
  ],
}
async function submit() {
  await formRef.value.validate()
  const amountCent = yuanToCent(form.amount_yuan)
  const payload = { reason: form.reason.trim() }
  if (amountCent !== undefined) payload.amount_cent = amountCent
  emit('submit', payload)
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  form.amount_yuan = null
  form.reason = ''
  formRef.value?.clearValidate()
})
</script>

<template>
  <el-dialog :model-value="modelValue" title="发起订单退款" width="min(520px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert :title="`订单 ${order?.order_no || ''}，可退总额 ${formatCentAmount(order?.amount_cent, order?.currency)}`" description="金额留空将申请全额退款。提交后以支付平台返回结果为准。" type="warning" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="refund-form">
      <el-form-item label="退款金额（元）" prop="amount_yuan"><el-input-number v-model="form.amount_yuan" :min="0.01" :max="Number(order?.amount_cent || 0) / 100" :precision="2" :step="1" controls-position="right" placeholder="留空则全额退款" /></el-form-item>
      <el-form-item label="退款原因" prop="reason"><el-input v-model="form.reason" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="请填写可审计的退款原因" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="danger" :loading="submitting" @click="submit">确认退款</el-button></template>
  </el-dialog>
</template>

<style scoped>.refund-form{margin-top:18px}.refund-form :deep(.el-input-number){width:100%}</style>
