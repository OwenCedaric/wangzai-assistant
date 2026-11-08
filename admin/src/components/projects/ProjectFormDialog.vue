<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  project: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ name: '', code: '', version: '', description: '', status: 'active' })
const rules = {
  name: [{ required: true, message: '请输入项目名称', trigger: 'blur' }],
  code: [
    { required: true, message: '请输入项目代码', trigger: 'blur' },
    { pattern: /^[a-z][a-z0-9_.-]{1,95}$/, message: '以小写字母开头，仅支持小写字母、数字、点、横线和下划线', trigger: 'blur' },
  ],
  version: [{ required: true, message: '请输入当前版本', trigger: 'blur' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    name: props.project?.name || '', code: props.project?.code || '',
    version: props.project?.version || '', description: props.project?.description || '',
    status: props.project?.status || 'active',
  })
  formRef.value?.clearValidate()
})

async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (valid) emit('submit', { ...form, name: form.name.trim(), code: form.code.trim(), version: form.version.trim(), description: form.description.trim() })
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="project ? '编辑项目' : '新增项目'" width="min(560px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid">
        <el-form-item label="项目名称" prop="name"><el-input v-model="form.name" placeholder="例如：运营助手" /></el-form-item>
        <el-form-item label="项目代码" prop="code"><el-input v-model="form.code" class="mono" placeholder="operation_helper" :disabled="Boolean(project)" /></el-form-item>
        <el-form-item label="当前版本" prop="version"><el-input v-model="form.version" placeholder="1.0.0" /></el-form-item>
        <el-form-item label="状态" prop="status"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
      </div>
      <el-form-item label="项目说明" prop="description"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="说明项目用途与适用场景" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">保存项目</el-button></template>
  </el-dialog>
</template>

<style scoped>.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }.el-select { width: 100%; }@media(max-width:600px){.form-grid{grid-template-columns:1fr;}}</style>
