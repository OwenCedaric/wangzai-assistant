<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({ modelValue: { type: Boolean, default: false }, user: { type: Object, default: null }, submitting: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ password: '', phone: '', email: '', status: 'active', is_admin: false })
const rules = {
  email: [{ required: true, message: '请输入注册邮箱', trigger: 'blur' }, { type: 'email', message: '请输入正确的邮箱地址', trigger: 'blur' }],
  password: [{ validator: (_rule, value, callback) => { if (!props.user && !value) callback(new Error('请输入初始密码')); else if (value && value.length < 8) callback(new Error('密码至少 8 位')); else callback() }, trigger: 'blur' }],
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, { password: '', phone: props.user?.phone || '', email: props.user?.email || '', status: props.user?.status || 'active', is_admin: Boolean(props.user?.is_admin) })
  formRef.value?.clearValidate()
})
async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  const email = form.email.trim().toLowerCase()
  const payload = { username: email, phone: form.phone.trim() || null, email, status: form.status, is_admin: form.is_admin }
  if (form.password) payload.password = form.password
  emit('submit', payload)
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="user ? '编辑用户' : '新增用户'" width="min(580px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid"><el-form-item label="注册邮箱（同时作为用户名）" prop="email"><el-input v-model="form.email" type="email" autocomplete="email" /></el-form-item><el-form-item :label="user ? '重置密码（留空则不修改）' : '初始密码'" prop="password"><el-input v-model="form.password" type="password" show-password autocomplete="new-password" /></el-form-item><el-form-item label="手机号" prop="phone"><el-input v-model="form.phone" /></el-form-item><el-form-item label="账号状态" prop="status"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item><el-form-item label="管理权限" prop="is_admin"><el-switch v-model="form.is_admin" active-text="管理员" inactive-text="普通用户" /></el-form-item></div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">保存用户</el-button></template>
  </el-dialog>
</template>

<style scoped>.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.el-select{width:100%}@media(max-width:580px){.form-grid{grid-template-columns:1fr}}</style>
