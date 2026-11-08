<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { makeChannelCode } from '../../utils/commerce.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  channel: { type: Object, default: null },
  agents: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ agent_id: '', project_id: '', code: '', name: '', campaign: '', status: 'active' })
const editing = computed(() => Boolean(props.channel?.id))
const selectedAgent = computed(() => props.agents.find((item) => item.id === form.agent_id))
const projectOptions = computed(() => {
  const allowed = selectedAgent.value?.project_ids
  if (!Array.isArray(allowed)) return props.projects
  return props.projects.filter((item) => allowed.includes(item.id))
})
const rules = {
  agent_id: [{ required: true, message: '请选择代理', trigger: 'change' }],
  project_id: [{ required: true, message: '请选择软件项目', trigger: 'change' }],
  code: [
    { required: true, message: '请生成或输入渠道码', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9_-]{4,50}$/, message: '渠道码格式不正确', trigger: 'blur' },
  ],
}

function resetForm() {
  const source = props.channel || {}
  Object.assign(form, {
    agent_id: source.agent_id || '', project_id: source.project_id || '',
    code: source.code || makeChannelCode(), name: source.name || '', campaign: source.campaign || '',
    status: source.status || 'active',
  })
  formRef.value?.clearValidate()
}
function regenerateCode() { form.code = makeChannelCode() }
async function submit() {
  await formRef.value.validate()
  emit('submit', {
    agent_id: form.agent_id, project_id: form.project_id, code: form.code.trim().toUpperCase(),
    name: form.name.trim() || null, campaign: form.campaign.trim() || null, status: form.status,
  })
}
watch(() => props.modelValue, (visible) => { if (visible) resetForm() })
watch(() => form.agent_id, () => {
  if (!editing.value && !projectOptions.value.some((item) => item.id === form.project_id)) form.project_id = ''
})
</script>

<template>
  <el-dialog :model-value="modelValue" :title="editing ? '编辑渠道' : '生成代理渠道'" width="min(600px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert v-if="!editing" title="创建后会生成一次性分发 Token，请立即复制到对应安装包配置中。" type="info" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="channel-form">
      <div class="form-grid">
        <el-form-item label="所属代理" prop="agent_id"><el-select v-model="form.agent_id" :disabled="editing" filterable style="width:100%"><el-option v-for="agent in agents" :key="agent.id" :label="`${agent.name} (${agent.code})`" :value="agent.id" :disabled="!editing && agent.status !== 'active'" /></el-select></el-form-item>
        <el-form-item label="软件项目" prop="project_id"><el-select v-model="form.project_id" :disabled="editing" filterable style="width:100%"><el-option v-for="project in projectOptions" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item>
        <el-form-item label="渠道名称" prop="name"><el-input v-model="form.name" maxlength="80" placeholder="例如 华东客户群" /></el-form-item>
        <el-form-item label="活动标识" prop="campaign"><el-input v-model="form.campaign" maxlength="80" placeholder="选填，例如 2026_SUMMER" /></el-form-item>
      </div>
      <el-form-item label="渠道码" prop="code"><el-input v-model="form.code" :disabled="editing" maxlength="50"><template #append><el-button :disabled="editing" :icon="Refresh" aria-label="重新生成渠道码" @click="regenerateCode" /></template></el-input></el-form-item>
      <el-form-item label="状态"><el-radio-group v-model="form.status"><el-radio-button value="active">启用</el-radio-button><el-radio-button value="disabled">禁用</el-radio-button></el-radio-group></el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">{{ editing ? '保存渠道' : '生成渠道与 Token' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
.channel-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}}
</style>
