<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({ modelValue: { type: Boolean, default: false }, plans: { type: Array, default: () => [] }, submitting: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ plan_id: '', quantity: 100, duration_days: 30 })
const selectedPlan = computed(() => props.plans.find((item) => item.id === form.plan_id))
const rules = {
  plan_id: [{ required: true, message: '请选择套餐', trigger: 'change' }],
  quantity: [{ required: true, message: '请输入生成数量', trigger: 'blur' }],
  duration_days: [{ required: true, message: '请输入授权有效期', trigger: 'blur' }],
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  const plan = props.plans[0]
  Object.assign(form, { plan_id: plan?.id || '', quantity: 100, duration_days: plan?.duration_days || 30 })
  formRef.value?.clearValidate()
})
watch(() => form.plan_id, () => { if (selectedPlan.value?.duration_days) form.duration_days = selectedPlan.value.duration_days })
async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (valid) emit('submit', { ...form })
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="批量生成卡密" width="min(560px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="卡密由服务端使用安全随机源生成，格式为 XXXX-XXXX-XXXX-XXXX。" type="info" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="batch-form">
      <el-form-item label="授权套餐" prop="plan_id"><el-select v-model="form.plan_id" filterable placeholder="选择套餐"><el-option v-for="item in plans" :key="item.id" :label="`${item.name} · ${item.duration_days}天 · ¥${(Number(item.sale_price_cent || 0) / 100).toFixed(2)}`" :value="item.id" /></el-select></el-form-item>
      <div class="form-grid"><el-form-item label="生成数量" prop="quantity"><el-input-number v-model="form.quantity" :min="1" :max="10000" :step="10" /></el-form-item><el-form-item label="激活后有效期（天）" prop="duration_days"><el-input-number v-model="form.duration_days" :min="1" :max="3650" disabled /></el-form-item></div>
      <div class="summary">即将生成 <strong>{{ form.quantity }}</strong> 个“{{ selectedPlan?.name || '未选择套餐' }}”卡密</div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">确认生成</el-button></template>
  </el-dialog>
</template>

<style scoped>.batch-form{margin-top:18px}.el-select{width:100%}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.form-grid .el-input-number{width:100%}.summary{padding:13px 15px;border-radius:9px;color:var(--lc-muted);background:#f5f7fb;font-size:13px}.summary strong{color:#315efb}@media(max-width:520px){.form-grid{grid-template-columns:1fr}}</style>
