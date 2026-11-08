<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  keyItem: { type: Object, default: null },
  mode: { type: String, default: 'create' },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ label: '', secret: '', weight: 100, max_concurrency: 0, status: 'active' })
const title = computed(() => ({ create: '添加 API Key', edit: '编辑 API Key', rotate: '更换 API Key' })[props.mode])
const needsSecret = computed(() => props.mode !== 'edit')
const rules = computed(() => ({
  label: props.mode === 'rotate' ? [] : [{ required: true, message: '请输入 Key 名称', trigger: 'blur' }],
  secret: needsSecret.value ? [{ required: true, min: 8, message: '请输入完整 API Key', trigger: 'blur' }] : [],
}))

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    label: props.keyItem?.label || '',
    secret: '',
    weight: props.keyItem?.weight || 100,
    max_concurrency: props.keyItem?.max_concurrency ?? 0,
    status: props.keyItem?.status === 'disabled' ? 'disabled' : 'active',
  })
})

async function submit() {
  await formRef.value?.validate()
  if (props.mode === 'rotate') return emit('submit', { secret: form.secret })
  const payload = {
    label: form.label.trim(), weight: form.weight, max_concurrency: form.max_concurrency,
  }
  if (props.mode === 'create') payload.secret = form.secret
  else payload.status = form.status
  emit('submit', payload)
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title" width="min(540px, 94vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert v-if="needsSecret" title="完整 Key 只在本次提交时传给服务端加密，保存后后台也只显示首尾掩码，不能再次查看明文。" type="warning" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="dialog-form">
      <el-form-item v-if="mode !== 'rotate'" label="Key 名称" prop="label"><el-input v-model="form.label" maxlength="128" placeholder="例如 主账号 Key 1" /></el-form-item>
      <el-form-item v-if="needsSecret" label="完整 API Key" prop="secret"><el-input v-model="form.secret" type="password" show-password autocomplete="new-password" /></el-form-item>
      <div v-if="mode !== 'rotate'" class="form-grid">
        <el-form-item label="调度权重"><el-input-number v-model="form.weight" :min="1" :max="1000" :controls="false" /></el-form-item>
        <el-form-item label="该 Key 最大并发"><el-input-number v-model="form.max_concurrency" :min="0" :max="100" :controls="false" /><div class="field-tip">填写 0 表示不设软件上限，由中转站自行限流。</div></el-form-item>
      </div>
      <el-form-item v-if="mode === 'edit'" label="状态"><el-radio-group v-model="form.status"><el-radio-button value="active">启用</el-radio-button><el-radio-button value="disabled">停用</el-radio-button></el-radio-group></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">{{ mode === 'rotate' ? '确认更换' : '保存' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
.dialog-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.form-grid :deep(.el-input-number){width:100%}.field-tip{margin-top:5px;color:var(--lc-muted);font-size:12px;line-height:1.45}@media(max-width:560px){.form-grid{grid-template-columns:1fr}}
</style>
