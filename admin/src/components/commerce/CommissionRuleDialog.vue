<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  rule: { type: Object, default: null },
  agents: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  products: { type: Array, default: () => [] },
  plans: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ agent_id: '', scope: 'global', project_id: '', plan_id: '', rate_percent: 0, status: 'active' })
const editing = computed(() => Boolean(props.rule?.id))
const selectedAgent = computed(() => props.agents.find((item) => item.id === form.agent_id))
const projectOptions = computed(() => {
  const allowed = selectedAgent.value?.project_ids
  if (!Array.isArray(allowed)) return props.projects
  return props.projects.filter((item) => allowed.includes(item.id) || item.id === props.rule?.project_id)
})
const productMap = computed(() => new Map(props.products.map((item) => [item.id, item])))
const planOptions = computed(() => props.plans.filter((plan) => productMap.value.get(plan.product_id)?.project_id === form.project_id))
const rules = {
  agent_id: [{ required: true, message: '请选择代理', trigger: 'change' }],
  project_id: [{ validator: (rule, value, callback) => form.scope === 'global' || value ? callback() : callback(new Error('请选择项目')), trigger: 'change' }],
  plan_id: [{ validator: (rule, value, callback) => form.scope !== 'plan' || value ? callback() : callback(new Error('请选择套餐')), trigger: 'change' }],
}

function inferScope(rule) {
  if (rule?.plan_id) return 'plan'
  if (rule?.project_id) return 'project'
  return 'global'
}
function resetForm() {
  const source = props.rule || {}
  Object.assign(form, {
    agent_id: source.agent_id || '', scope: inferScope(source), project_id: source.project_id || '',
    plan_id: source.plan_id || '', rate_percent: Number(source.rate_bps || 0) / 100,
    status: source.status || 'active',
  })
  formRef.value?.clearValidate()
}
async function submit() {
  await formRef.value.validate()
  emit('submit', {
    agent_id: form.agent_id,
    project_id: form.scope === 'global' ? null : form.project_id,
    plan_id: form.scope === 'plan' ? form.plan_id : null,
    rate_bps: Math.round(Number(form.rate_percent || 0) * 100),
    status: form.status,
  })
}
watch(() => props.modelValue, (visible) => { if (visible) resetForm() })
watch(() => form.scope, (scope) => { if (scope === 'global') form.project_id = ''; if (scope !== 'plan') form.plan_id = '' })
watch(() => form.agent_id, () => { if (!editing.value && !projectOptions.value.some((item) => item.id === form.project_id)) form.project_id = '' })
watch(() => form.project_id, () => { if (!editing.value && !planOptions.value.some((item) => item.id === form.plan_id)) form.plan_id = '' })
</script>

<template>
  <el-dialog :model-value="modelValue" :title="editing ? '编辑佣金规则' : '新增佣金规则'" width="min(580px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="代理" prop="agent_id"><el-select v-model="form.agent_id" :disabled="editing" filterable style="width:100%"><el-option v-for="agent in agents" :key="agent.id" :label="`${agent.name} (${agent.code})`" :value="agent.id" :disabled="!editing && agent.status !== 'active'" /></el-select></el-form-item>
      <el-form-item label="规则范围"><el-radio-group v-model="form.scope" :disabled="editing"><el-radio-button value="global">代理全局</el-radio-button><el-radio-button value="project">指定项目</el-radio-button><el-radio-button value="plan">指定套餐</el-radio-button></el-radio-group></el-form-item>
      <el-form-item v-if="form.scope !== 'global'" label="项目" prop="project_id"><el-select v-model="form.project_id" :disabled="editing" filterable style="width:100%"><el-option v-for="project in projectOptions" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item>
      <el-form-item v-if="form.scope === 'plan'" label="套餐" prop="plan_id"><el-select v-model="form.plan_id" :disabled="editing" filterable style="width:100%"><el-option v-for="plan in planOptions" :key="plan.id" :label="plan.name" :value="plan.id" /></el-select></el-form-item>
      <div class="form-grid"><el-form-item label="佣金比例"><el-input-number v-model="form.rate_percent" :min="0" :max="100" :precision="2" :step="0.5" controls-position="right" /><span class="unit">%</span></el-form-item><el-form-item label="状态"><el-radio-group v-model="form.status"><el-radio-button value="active">启用</el-radio-button><el-radio-button value="disabled">停用</el-radio-button></el-radio-group></el-form-item></div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存规则</el-button></template>
  </el-dialog>
</template>

<style scoped>.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.unit{margin-left:8px;color:var(--lc-muted)}@media(max-width:560px){.form-grid{grid-template-columns:1fr}}</style>
