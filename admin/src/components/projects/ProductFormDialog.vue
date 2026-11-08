<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false }, product: { type: Object, default: null },
  projects: { type: Array, default: () => [] }, submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ project_id: '', name: '', version: '', description: '', status: 'active' })
const rules = {
  project_id: [{ required: true, message: '请选择所属项目', trigger: 'change' }],
  name: [{ required: true, message: '请输入产品名称', trigger: 'blur' }],
  version: [{ required: true, message: '请输入产品版本', trigger: 'blur' }],
}
watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    project_id: props.product?.project_id || props.projects[0]?.id || '', name: props.product?.name || '',
    version: props.product?.version || '', description: props.product?.description || '', status: props.product?.status || 'active',
  })
  formRef.value?.clearValidate()
})
async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (valid) emit('submit', { ...form, name: form.name.trim(), version: form.version.trim(), description: form.description.trim() })
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="product ? '编辑产品版本' : '新增产品版本'" width="min(520px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="所属项目" prop="project_id"><el-select v-model="form.project_id" filterable placeholder="选择软件项目"><el-option v-for="item in projects" :key="item.id" :label="`${item.name} (${item.code})`" :value="item.id" /></el-select></el-form-item>
      <div class="form-grid"><el-form-item label="产品名称" prop="name"><el-input v-model="form.name" placeholder="例如：桌面客户端" /></el-form-item><el-form-item label="产品版本" prop="version"><el-input v-model="form.version" placeholder="1.0.0" /></el-form-item></div>
      <el-form-item label="状态" prop="status"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
      <el-form-item label="产品说明" prop="description"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">保存产品</el-button></template>
  </el-dialog>
</template>

<style scoped>.el-select{width:100%}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:560px){.form-grid{grid-template-columns:1fr}}</style>
