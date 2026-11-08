<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  rate: { type: Object, default: null },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ costCny: 0, sellPriceCny: 0 })

const pointsPerImage = computed(() => Math.ceil(
  Number(form.sellPriceCny || 0) * Number(props.rate?.points_per_cny || 1050),
))
const grossMargin = computed(() => {
  const price = Number(form.sellPriceCny || 0)
  if (!price) return '0%'
  return `${(((price - Number(form.costCny || 0)) / price) * 100).toFixed(2)}%`
})
const rules = {
  costCny: [{ validator: (_rule, value, done) => Number(value) > 0 ? done() : done(new Error('成本必须大于0')), trigger: 'blur' }],
  sellPriceCny: [{
    validator: (_rule, value, done) => Number(value) >= Number(form.costCny)
      ? done()
      : done(new Error('用户价不能低于成本价')),
    trigger: 'blur',
  }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible || !props.rate) return
  form.costCny = Number(props.rate.unit_cost_micros || 0) / 1_000_000
  form.sellPriceCny = Number(props.rate.unit_sell_price_micros || 0) / 1_000_000
})

async function confirm() {
  await formRef.value?.validate()
  emit('submit', {
    unit_cost_micros: Math.round(Number(form.costCny) * 1_000_000),
    unit_sell_price_micros: Math.round(Number(form.sellPriceCny) * 1_000_000),
  })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="调整生图模型价格"
    width="min(560px, 94vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      title="保存后立即创建新价格版本；已预占的旧任务继续按旧版本结算。"
      type="warning"
      :closable="false"
      show-icon
    />
    <div v-if="rate" class="model-summary">
      <strong>{{ rate.provider_model }}</strong>
      <span>{{ rate.capability }} · {{ rate.points_per_cny }}积分/元</span>
    </div>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="price-grid">
        <el-form-item label="内部成本（元/张）" prop="costCny">
          <el-input-number v-model="form.costCny" :min="0.0001" :precision="4" :step="0.01" />
        </el-form-item>
        <el-form-item label="用户价格（元/张）" prop="sellPriceCny">
          <el-input-number v-model="form.sellPriceCny" :min="0.0001" :precision="4" :step="0.01" />
        </el-form-item>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="每张扣除">{{ pointsPerImage }} 积分</el-descriptions-item>
        <el-descriptions-item label="预计毛利率">{{ grossMargin }}</el-descriptions-item>
      </el-descriptions>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">保存并立即生效</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.model-summary{display:flex;flex-direction:column;gap:5px;margin:18px 0;color:#172033}.model-summary span{font-size:13px;color:var(--lc-muted)}.price-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.el-input-number{width:100%}@media(max-width:620px){.price-grid{grid-template-columns:1fr}}
</style>
