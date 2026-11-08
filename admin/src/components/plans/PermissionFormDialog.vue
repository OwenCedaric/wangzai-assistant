<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false }, permission: { type: Object, default: null },
  projects: { type: Array, default: () => [] }, submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ project_id: '', code: '', name: '', description: '', status: 'active' })
const rules = {
  project_id: [{ required: true, message: '请选择所属项目', trigger: 'change' }],
  code: [{ required: true, message: '请输入权限代码', trigger: 'blur' }, { pattern: /^[a-z][a-z0-9_.-]{1,95}$/, message: '使用小写字母、数字、下划线、点或连字符', trigger: 'blur' }],
  name: [{ required: true, message: '请输入权限名称', trigger: 'blur' }],
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    project_id: props.permission?.project_id || props.projects[0]?.id || '', code: props.permission?.code || '',
    name: props.permission?.name || '', description: props.permission?.description || '', status: props.permission?.status || 'active',
  })
  formRef.value?.clearValidate()
})
async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (valid) emit('submit', { project_id: form.project_id, code: form.code.trim(), name: form.name.trim(), description: form.description.trim(), status: form.status })
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="permission ? '编辑权限' : '新增权限'" width="min(520px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="所属项目" prop="project_id"><el-select v-model="form.project_id" filterable :disabled="Boolean(permission)" placeholder="选择该权限所属的软件项目"><el-option v-for="item in projects" :key="item.id" :label="`${item.name} (${item.code})`" :value="item.id" /></el-select></el-form-item>
      <el-form-item label="权限代码" prop="code"><el-input v-model="form.code" class="mono" placeholder="例如：order_sync" :disabled="Boolean(permission)" /></el-form-item>
      <div class="form-grid"><el-form-item label="权限名称" prop="name"><el-input v-model="form.name" placeholder="例如：订单同步" /></el-form-item><el-form-item label="状态" prop="status"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item></div>
      <el-form-item label="权限说明" prop="description"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="300" show-word-limit /></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">保存权限</el-button></template>
  </el-dialog>
</template>

<style scoped>.el-select{width:100%}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:520px){.form-grid{grid-template-columns:1fr}}</style>
