<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  projects: { type: Array, default: () => [] },
  apiProviders: { type: Array, default: () => [] },
  apiModels: { type: Array, default: () => [] },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()

const capabilities = [
  ['text.product-description', '商品描述', 'text', 'builtin-text'],
  ['text.image-plan', '图片方案分析', 'text', 'builtin-text'],
  ['text.data-analysis', '店铺经营分析', 'text', 'builtin-text'],
  ['text.external-insight', '外部数据解释', 'text', 'builtin-text'],
  ['text.openclaw-chat', '微信助理对话', 'text', 'builtin-text'],
  ['image.generate', '图片生成', 'image', 'builtin-image'],
  ['image.edit', '图片编辑', 'image', 'builtin-image'],
  ['external.seerfar.shop', 'Seerfar 店铺查询', 'seerfar', 'seerfar'],
  ['external.seerfar.product-detail', 'Seerfar 商品详情', 'seerfar', 'seerfar'],
  ['external.seerfar.category', 'Seerfar 类目查询', 'seerfar', 'seerfar'],
  ['external.seerfar.product-report', 'Seerfar 商品报告', 'seerfar', 'seerfar'],
  ['external.seerfar.market-keyword', 'Seerfar 市场关键词', 'seerfar', 'seerfar'],
  ['external.seerfar.keyword-mining', 'Seerfar 关键词挖掘', 'seerfar', 'seerfar'],
  ['external.seerfar.keyword-back', 'Seerfar 反查关键词', 'seerfar', 'seerfar'],
].map(([value, label, kind, legacyProvider]) => ({ value, label, kind, legacyProvider }))

const form = reactive({
  project_id: '',
  capability: 'text.product-description',
  price_version: '',
  provider_code: 'builtin-text',
  provider_model: 'gpt-5.6-sol',
  input_cost_cny_per_million: 0,
  output_cost_cny_per_million: 0,
  cached_input_cost_cny_per_million: 0,
  fixed_cost_cny: 0,
  unit_cost_cny: 0,
  unit_sell_price_cny: 0,
  provider_multiplier_percent: 100,
  customer_multiplier_percent: 120,
  risk_buffer_percent: 5,
  target_margin_percent: 0,
  points_per_cny: 1050,
  effective_from: new Date(),
  effective_until: null,
})

const selectedCapability = computed(() => capabilities.find((item) => item.value === form.capability))
const isModelProvider = computed(() => selectedCapability.value?.kind !== 'seerfar')
const isImageCapability = computed(() => selectedCapability.value?.kind === 'image')
const isTextCapability = computed(() => selectedCapability.value?.kind === 'text')
const availableProviders = computed(() => {
  const capability = selectedCapability.value
  if (!capability) return []
  const pool = props.apiProviders.filter((item) => (
    item.status === 'active' && item.capability_kinds?.includes(capability.kind)
  )).map((item) => ({ code: item.code, name: item.name, poolId: item.id }))
  return [
    ...pool,
    { code: capability.legacyProvider, name: `旧环境配置 · ${capability.legacyProvider}`, poolId: null },
  ]
})
const selectedProvider = computed(() => availableProviders.value.find((item) => item.code === form.provider_code))
const availableModels = computed(() => props.apiModels.filter((item) => (
  item.provider_id === selectedProvider.value?.poolId
  && item.capability_kind === selectedCapability.value?.kind
  && item.status === 'active'
)))
const rules = {
  project_id: [{ required: true, message: '请选择项目', trigger: 'change' }],
  capability: [{ required: true, message: '请选择计费能力', trigger: 'change' }],
  price_version: [{ required: true, message: '请填写价格版本', trigger: 'blur' }],
  provider_model: [{ validator: (_rule, value, done) => !isModelProvider.value || String(value || '').trim() ? done() : done(new Error('请填写服务端模型')), trigger: 'blur' }],
}

function reset() {
  Object.assign(form, {
    project_id: props.projects[0]?.id || '',
    capability: 'text.product-description',
    price_version: `rate-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    provider_code: '',
    provider_model: 'gpt-5.6-sol',
    input_cost_cny_per_million: 0,
    output_cost_cny_per_million: 0,
    cached_input_cost_cny_per_million: 0,
    fixed_cost_cny: 0,
    unit_cost_cny: 0,
    unit_sell_price_cny: 0,
    provider_multiplier_percent: 100,
    customer_multiplier_percent: 120,
    risk_buffer_percent: 5,
    target_margin_percent: 0,
    points_per_cny: 1050,
    effective_from: new Date(),
    effective_until: null,
  })
  resetProvider()
}

watch(() => props.modelValue, (visible) => { if (visible) reset() })
watch(() => form.capability, () => {
  resetProvider()
  form.customer_multiplier_percent = isTextCapability.value ? 120 : 100
  form.target_margin_percent = isTextCapability.value ? 0 : 18
})
watch(() => form.provider_code, resetModel)

function resetProvider() {
  form.provider_code = availableProviders.value[0]?.code || selectedCapability.value?.legacyProvider || ''
  resetModel()
}

function resetModel() {
  if (!isModelProvider.value) form.provider_model = ''
  else if (availableModels.value.length) form.provider_model = availableModels.value[0].model_code
  else if (!selectedProvider.value?.poolId) {
    form.provider_model = selectedCapability.value?.kind === 'image' ? 'gpt-image-2' : 'gpt-5.6-sol'
  } else form.provider_model = ''
}

function micros(value) {
  return Math.max(0, Math.round(Number(value || 0) * 1_000_000))
}

async function confirm() {
  await formRef.value?.validate()
  emit('submit', {
    project_id: Number(form.project_id),
    capability: form.capability,
    version: 1,
    price_version: String(form.price_version).trim(),
    provider_code: form.provider_code,
    provider_model: String(form.provider_model || '').trim(),
    input_micros_per_million: micros(form.input_cost_cny_per_million),
    output_micros_per_million: micros(form.output_cost_cny_per_million),
    cached_input_micros_per_million: micros(form.cached_input_cost_cny_per_million),
    fixed_cost_micros: micros(form.fixed_cost_cny),
    unit_cost_micros: micros(form.unit_cost_cny),
    unit_sell_price_micros: micros(form.unit_sell_price_cny),
    provider_multiplier_ppm: Math.round(Number(form.provider_multiplier_percent) * 10_000),
    customer_multiplier_ppm: Math.round(Number(form.customer_multiplier_percent) * 10_000),
    risk_buffer_basis_points: Math.round(Number(form.risk_buffer_percent) * 100),
    target_margin_basis_points: Math.round(Number(form.target_margin_percent) * 100),
    minimum_margin_basis_points: isTextCapability.value ? 0 : 1500,
    points_per_cny: Number(form.points_per_cny),
    currency: 'CNY',
    effective_from: new Date(form.effective_from).toISOString(),
    effective_until: form.effective_until ? new Date(form.effective_until).toISOString() : null,
  })
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="新增付费能力价格版本" width="min(760px, 94vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="价格版本创建后不可覆盖。先停用旧版本，再创建不重叠的新版本；服务端始终先预占积分，成功后按真实用量结算。" type="warning" :closable="false" show-icon />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="rate-form">
      <div class="form-grid">
        <el-form-item label="所属项目" prop="project_id"><el-select v-model="form.project_id" filterable><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="计费能力" prop="capability"><el-select v-model="form.capability" filterable><el-option v-for="item in capabilities" :key="item.value" :label="`${item.label} · ${item.value}`" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="价格版本" prop="price_version"><el-input v-model="form.price_version" maxlength="128" /></el-form-item>
        <el-form-item label="API 供应商"><el-select v-model="form.provider_code"><el-option v-for="item in availableProviders" :key="item.code" :label="item.name" :value="item.code" /></el-select></el-form-item>
        <el-form-item v-if="isModelProvider" label="服务端模型" prop="provider_model"><el-select v-if="selectedProvider?.poolId" v-model="form.provider_model" filterable><el-option v-for="item in availableModels" :key="item.id" :label="`${item.display_name} · ${item.model_code}`" :value="item.model_code" /></el-select><el-input v-else v-model="form.provider_model" maxlength="160" /></el-form-item>
      </div>
      <el-divider content-position="left">上游真实成本（人民币）</el-divider>
      <div class="form-grid form-grid--3">
        <el-form-item label="输入 / 百万 Token"><el-input-number v-model="form.input_cost_cny_per_million" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item label="输出 / 百万 Token"><el-input-number v-model="form.output_cost_cny_per_million" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item label="缓存输入 / 百万 Token"><el-input-number v-model="form.cached_input_cost_cny_per_million" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item label="每次固定成本"><el-input-number v-model="form.fixed_cost_cny" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item label="每单位成本（张/次）"><el-input-number v-model="form.unit_cost_cny" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item v-if="isImageCapability" label="每张用户价格"><el-input-number v-model="form.unit_sell_price_cny" :min="0" :precision="6" :controls="false" /></el-form-item>
        <el-form-item label="供应商倍率 %"><el-input-number v-model="form.provider_multiplier_percent" :min="0.0001" :precision="4" :controls="false" /></el-form-item>
      </div>
      <el-divider content-position="left">售价与生效时间</el-divider>
      <el-alert v-if="isTextCapability" title="文本模型最终扣费固定为上游实际成本的 1.2 倍；风险缓冲只用于预占，最终结算不会重复叠加毛利。" type="info" :closable="false" show-icon />
      <div class="form-grid form-grid--3">
        <el-form-item label="用户扣费倍率 %"><el-input-number v-model="form.customer_multiplier_percent" :min="isTextCapability ? 120 : 100" :max="isTextCapability ? 120 : 1000" :precision="2" :disabled="isTextCapability" /></el-form-item>
        <el-form-item label="风险缓冲 %"><el-input-number v-model="form.risk_buffer_percent" :min="0" :max="100" :precision="2" /></el-form-item>
        <el-form-item :label="isTextCapability ? '额外毛利 %' : '目标毛利 %（15–20）'"><el-input-number v-model="form.target_margin_percent" :min="isTextCapability ? 0 : 15" :max="isTextCapability ? 0 : 20" :precision="2" :disabled="isTextCapability" /></el-form-item>
        <el-form-item label="每元对应积分"><el-input-number v-model="form.points_per_cny" :min="1" :precision="0" :controls="false" /></el-form-item>
        <el-form-item label="生效时间"><el-date-picker v-model="form.effective_from" type="datetime" /></el-form-item>
        <el-form-item label="失效时间（可选）"><el-date-picker v-model="form.effective_until" type="datetime" clearable /></el-form-item>
      </div>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">创建价格版本</el-button></template>
  </el-dialog>
</template>

<style scoped>
.rate-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.form-grid--3{grid-template-columns:repeat(3,minmax(0,1fr))}.el-select,.el-input-number,.el-date-editor{width:100%}@media(max-width:720px){.form-grid,.form-grid--3{grid-template-columns:1fr}}
</style>
