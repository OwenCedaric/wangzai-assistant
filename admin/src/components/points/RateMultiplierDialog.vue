<script setup>
import { computed, reactive, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  rate: { type: Object, default: null },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const form = reactive({ providerPercent: 100, customerPercent: 100 })
const exactTextMarkup = computed(() => (
  String(props.rate?.capability || '').startsWith('text.')
  && Number(props.rate?.target_margin_basis_points) === 0
  && Number(props.rate?.minimum_margin_basis_points) === 0
))

watch(() => props.rate, (rate) => {
  form.providerPercent = Number(rate?.provider_multiplier_ppm || 1_000_000) / 10_000
  form.customerPercent = Number(rate?.customer_multiplier_ppm || 1_000_000) / 10_000
}, { immediate: true })

function submit() {
  emit('submit', {
    provider_multiplier_ppm: Math.round(Number(form.providerPercent) * 10_000),
    customer_multiplier_ppm: Math.round(Number(form.customerPercent) * 10_000),
  })
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="调整计费倍率" width="min(560px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="保存后创建新价格版本，历史订单和已预占任务不会被改写。" type="warning" :closable="false" show-icon />
    <el-descriptions :column="1" border class="rate-summary">
      <el-descriptions-item label="能力">{{ rate?.capability }}</el-descriptions-item>
      <el-descriptions-item label="模型">{{ rate?.provider_model || 'SF 按次查询' }}</el-descriptions-item>
    </el-descriptions>
    <el-form label-width="150px">
      <el-form-item label="上游成本倍率">
        <el-input-number v-model="form.providerPercent" :min="0.0001" :max="1000" :precision="4" /> %
      </el-form-item>
      <el-form-item label="用户扣费倍率">
        <el-input-number v-model="form.customerPercent" :min="exactTextMarkup ? 120 : 100" :max="exactTextMarkup ? 120 : 1000" :precision="2" :disabled="exactTextMarkup" /> %
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存并立即生效</el-button></template>
  </el-dialog>
</template>

<style scoped>.rate-summary{margin:16px 0}.el-input-number{margin-right:8px}</style>
