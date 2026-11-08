<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  provider: { type: Object, default: null },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const editing = computed(() => Boolean(props.provider))
const form = reactive({
  code: '', name: '', adapter: 'openai-compatible', base_url: '', auth_scheme: 'bearer',
  auth_header_name: 'Authorization', capability_kinds: ['text'], timeout_seconds: 150,
  priority: 100, status: 'active',
})
const rules = {
  code: [{ required: true, message: '请输入唯一供应商代码', trigger: 'blur' }],
  name: [{ required: true, message: '请输入供应商名称', trigger: 'blur' }],
  base_url: [{ required: true, message: '请输入 HTTPS API 根地址', trigger: 'blur' }],
  capability_kinds: [{ type: 'array', min: 1, message: '至少选择一种能力', trigger: 'change' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  const item = props.provider
  Object.assign(form, item ? {
    code: item.code,
    name: item.name,
    adapter: item.adapter,
    base_url: item.base_url,
    auth_scheme: item.auth_scheme,
    auth_header_name: item.auth_header_name,
    capability_kinds: [...item.capability_kinds],
    timeout_seconds: item.timeout_seconds,
    priority: item.priority,
    status: item.status,
  } : {
    code: '', name: '', adapter: 'openai-compatible', base_url: '', auth_scheme: 'bearer',
    auth_header_name: 'Authorization', capability_kinds: ['text'], timeout_seconds: 150,
    priority: 100, status: 'active',
  })
})

watch(() => form.adapter, (adapter) => {
  if (adapter === 'seerfar') {
    form.capability_kinds = ['seerfar']
    form.auth_scheme = 'bearer'
    form.auth_header_name = 'Authorization'
  } else if (form.capability_kinds.includes('seerfar')) {
    form.capability_kinds = ['text']
  }
})

async function submit() {
  await formRef.value?.validate()
  const payload = {
    name: form.name.trim(),
    adapter: form.adapter,
    base_url: form.base_url.trim(),
    auth_scheme: form.auth_scheme,
    auth_header_name: form.auth_scheme === 'bearer' ? 'Authorization' : form.auth_header_name.trim(),
    capability_kinds: [...form.capability_kinds],
    timeout_seconds: form.timeout_seconds,
    priority: form.priority,
  }
  if (editing.value) payload.status = form.status
  else payload.code = form.code.trim().toLowerCase()
  emit('submit', payload)
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="editing ? '编辑 API 供应商' : '新增 API 供应商'" width="min(680px, 94vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="API Key 不在这里填写。先建立供应商和模型，再进入密钥池添加多个 Key。根地址主机必须已加入服务端允许列表。" type="info" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="dialog-form">
      <div class="form-grid">
        <el-form-item label="供应商代码" prop="code"><el-input v-model="form.code" :disabled="editing" placeholder="例如 codesonline-text" /></el-form-item>
        <el-form-item label="显示名称" prop="name"><el-input v-model="form.name" placeholder="例如 CodesOnline 文本接口" /></el-form-item>
        <el-form-item label="接口适配器"><el-select v-model="form.adapter"><el-option label="OpenAI 兼容接口" value="openai-compatible" /><el-option label="Seerfar 接口" value="seerfar" /></el-select></el-form-item>
        <el-form-item v-if="editing" label="状态"><el-select v-model="form.status"><el-option label="启用" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
      </div>
      <el-form-item label="API 根地址" prop="base_url"><el-input v-model="form.base_url" placeholder="https://api.example.com/v1" /></el-form-item>
      <el-form-item label="支持能力" prop="capability_kinds"><el-checkbox-group v-model="form.capability_kinds" :disabled="form.adapter === 'seerfar'"><el-checkbox value="text">文本模型</el-checkbox><el-checkbox value="image">图片模型</el-checkbox><el-checkbox v-if="form.adapter === 'seerfar'" value="seerfar">Seerfar</el-checkbox></el-checkbox-group></el-form-item>
      <div class="form-grid">
        <el-form-item label="鉴权方式"><el-select v-model="form.auth_scheme"><el-option label="Authorization: Bearer" value="bearer" /><el-option label="自定义请求头" value="header" /></el-select></el-form-item>
        <el-form-item label="鉴权请求头"><el-input v-model="form.auth_header_name" :disabled="form.auth_scheme === 'bearer'" placeholder="X-API-Key" /></el-form-item>
        <el-form-item label="单次超时（秒）"><el-input-number v-model="form.timeout_seconds" :min="10" :max="300" :controls="false" /></el-form-item>
        <el-form-item label="显示优先级"><el-input-number v-model="form.priority" :min="1" :max="10000" :controls="false" /></el-form-item>
      </div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存供应商</el-button></template>
  </el-dialog>
</template>

<style scoped>
.dialog-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.form-grid :deep(.el-input-number),.form-grid :deep(.el-select){width:100%}@media(max-width:680px){.form-grid{grid-template-columns:1fr}}
</style>
