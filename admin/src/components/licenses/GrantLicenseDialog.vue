<script setup>
import { reactive, ref, watch } from 'vue'
import { userDisplayName } from '../../utils/userIdentity.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false }, users: { type: Array, default: () => [] },
  plans: { type: Array, default: () => [] }, submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ user_id: '', plan_id: '', start_time: '', expire_time: '', status: 'active' })
const rules = {
  user_id: [{ required: true, message: '请选择用户', trigger: 'change' }],
  plan_id: [{ required: true, message: '请选择套餐', trigger: 'change' }],
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, { user_id: props.users[0]?.id || '', plan_id: props.plans[0]?.id || '', start_time: '', expire_time: '', status: 'active' })
  formRef.value?.clearValidate()
})
async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  const payload = { user_id: form.user_id, plan_id: form.plan_id, status: form.status }
  if (form.start_time) payload.start_time = new Date(form.start_time).toISOString()
  if (form.expire_time) payload.expire_time = new Date(form.expire_time).toISOString()
  emit('submit', payload)
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="直接授予 License" width="min(580px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="直接授权适合人工开通；通过卡密激活的用户无需在此重复授权。" type="info" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="grant-form">
      <div class="form-grid"><el-form-item label="授权用户" prop="user_id"><el-select v-model="form.user_id" filterable><el-option v-for="item in users" :key="item.id" :label="userDisplayName(item)" :value="item.id" /></el-select></el-form-item><el-form-item label="授权套餐" prop="plan_id"><el-select v-model="form.plan_id" filterable><el-option v-for="item in plans" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="开始时间（可选）"><el-date-picker v-model="form.start_time" type="datetime" placeholder="默认立即生效" /></el-form-item><el-form-item label="到期时间（可选）"><el-date-picker v-model="form.expire_time" type="datetime" placeholder="默认按套餐周期" /></el-form-item></div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">确认授权</el-button></template>
  </el-dialog>
</template>

<style scoped>.grant-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.el-select,.el-date-editor{width:100%}@media(max-width:580px){.form-grid{grid-template-columns:1fr}}</style>
