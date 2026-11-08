<script setup>
import { reactive, ref, watch } from 'vue'
import { userDisplayName } from '../../utils/userIdentity.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  wallet: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ operation: 'credit', amount_points: 100, reason: '', validity_days: 30 })
const rules = {
  amount_points: [{ required: true, message: '请输入积分数量', trigger: 'blur' }],
  reason: [{ required: true, message: '请输入调整原因', trigger: 'blur' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, { operation: 'credit', amount_points: 100, reason: '', validity_days: 30 })
  formRef.value?.clearValidate()
})

function newIdempotencyKey() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  return `admin-adjust-${random}`.slice(0, 128)
}

async function confirm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  emit('submit', {
    operation: form.operation,
    amount_points: form.amount_points,
    reason: form.reason.trim(),
    validity_days: form.operation === 'credit' ? form.validity_days : undefined,
    idempotency_key: newIdempotencyKey(),
  })
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="调整积分余额" width="min(520px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <div v-if="wallet" class="wallet-summary">
      <span>{{ userDisplayName(wallet) }}</span>
      <strong>
        可用 {{ Number(wallet.available_points ?? wallet.balance_points ?? 0).toLocaleString('zh-CN') }}
        · 预占 {{ Number(wallet.reserved_points || 0).toLocaleString('zh-CN') }}
        · 总额 {{ Number(wallet.balance_points || 0).toLocaleString('zh-CN') }}
      </strong>
    </div>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="调整方式"><el-radio-group v-model="form.operation"><el-radio-button value="credit">增加积分</el-radio-button><el-radio-button value="debit">扣减积分</el-radio-button></el-radio-group></el-form-item>
      <div class="form-grid">
        <el-form-item label="积分数量" prop="amount_points"><el-input-number v-model="form.amount_points" :min="1" :max="2000000000" :controls="false" /></el-form-item>
        <el-form-item v-if="form.operation === 'credit'" label="有效期（天）"><el-input-number v-model="form.validity_days" :min="1" :max="3650" :controls="false" /></el-form-item>
      </div>
      <el-form-item label="调整原因" prop="reason"><el-input v-model="form.reason" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item>
      <el-alert v-if="form.operation === 'debit'" title="扣减只使用可用积分，并按最先到期的积分批次依次消耗；预占中的积分不会被扣除，可用余额不足时不会执行。" type="warning" :closable="false" show-icon />
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">确认调整</el-button></template>
  </el-dialog>
</template>

<style scoped>
.wallet-summary{display:flex;min-width:0;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;margin-bottom:18px;padding:13px 15px;border-radius:10px;background:#f5f7fb}.wallet-summary span{min-width:0;color:var(--lc-muted);overflow-wrap:anywhere}.wallet-summary strong{flex:0 0 auto;color:#315efb}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.el-input-number{width:100%}@media(max-width:520px){.form-grid{grid-template-columns:1fr}}
</style>
