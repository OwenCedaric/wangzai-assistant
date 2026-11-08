<script setup>
import { reactive, ref, watch } from 'vue'
import { centToYuan, yuanToCent } from '../../utils/commerce.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  packageItem: { type: Object, default: null },
  products: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({
  product_id: '',
  name: '',
  points_amount: 1000,
  sale_price_yuan: 9.9,
  validity_days: 30,
  customer_description: '',
  featured: false,
  display_order: 0,
  online_sale_enabled: true,
  status: 'active',
})
const rules = {
  product_id: [{ required: true, message: '请选择所属产品', trigger: 'change' }],
  name: [{ required: true, message: '请输入套餐名称', trigger: 'blur' }],
  points_amount: [{ required: true, message: '请输入积分数量', trigger: 'blur' }],
  sale_price_yuan: [{ required: true, message: '请输入售价', trigger: 'blur' }],
  validity_days: [{ required: true, message: '请输入有效期', trigger: 'blur' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    product_id: props.packageItem?.product_id || props.products[0]?.id || '',
    name: props.packageItem?.name || '',
    points_amount: Number(props.packageItem?.points_amount || 1000),
    sale_price_yuan: centToYuan(props.packageItem?.sale_price_cent ?? 990),
    validity_days: Number(props.packageItem?.validity_days || 30),
    customer_description: props.packageItem?.customer_description || '',
    featured: Boolean(props.packageItem?.featured),
    display_order: Number(props.packageItem?.display_order || 0),
    online_sale_enabled: props.packageItem?.online_sale_enabled ?? true,
    status: props.packageItem?.status || 'active',
  })
  formRef.value?.clearValidate()
})

async function confirm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || yuanToCent(form.sale_price_yuan) <= 0) return
  const { sale_price_yuan: salePriceYuan, ...payload } = form
  emit('submit', {
    ...payload,
    name: form.name.trim(),
    customer_description: form.customer_description.trim() || null,
    sale_price_cent: yuanToCent(salePriceYuan),
  })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="packageItem ? '编辑积分套餐' : '新增积分套餐'"
    width="min(680px, 92vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid form-grid--2">
        <el-form-item label="所属产品" prop="product_id">
          <el-select v-model="form.product_id" filterable :disabled="Boolean(packageItem)">
            <el-option v-for="item in products" :key="item.id" :label="`${item.name} · ${item.version}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="套餐名称" prop="name"><el-input v-model="form.name" placeholder="例如：专业积分包" /></el-form-item>
      </div>
      <div class="form-grid form-grid--3">
        <el-form-item label="积分数量" prop="points_amount"><el-input-number v-model="form.points_amount" :min="1" :max="2000000000" :controls="false" /></el-form-item>
        <el-form-item label="售价（元）" prop="sale_price_yuan"><el-input-number v-model="form.sale_price_yuan" :min="0.01" :precision="2" :controls="false" /></el-form-item>
        <el-form-item label="有效期（天）" prop="validity_days"><el-input-number v-model="form.validity_days" :min="1" :max="3650" :controls="false" /></el-form-item>
      </div>
      <el-form-item label="用户可见说明"><el-input v-model="form.customer_description" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item>
      <div class="form-grid form-grid--3">
        <el-form-item label="展示顺序"><el-input-number v-model="form.display_order" :min="0" :max="100000" :controls="false" /></el-form-item>
        <el-form-item label="推荐套餐"><el-switch v-model="form.featured" active-text="推荐" inactive-text="普通" /></el-form-item>
        <el-form-item label="在线销售"><el-switch v-model="form.online_sale_enabled" active-text="在售" inactive-text="停售" /></el-form-item>
      </div>
      <el-form-item label="套餐状态"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
      <el-alert title="积分套餐仅增加积分余额，不生成卡密，也不改变软件授权有效期。" type="info" :closable="false" show-icon />
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">保存积分套餐</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-grid{display:grid;gap:16px}.form-grid--2{grid-template-columns:repeat(2,1fr)}.form-grid--3{grid-template-columns:repeat(3,1fr)}.el-select,.el-input-number{width:100%}@media(max-width:620px){.form-grid--2,.form-grid--3{grid-template-columns:1fr}}
</style>
