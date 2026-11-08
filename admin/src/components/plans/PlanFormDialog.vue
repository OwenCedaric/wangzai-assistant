<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { centToYuan, yuanToCent } from '../../utils/commerce.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false }, plan: { type: Object, default: null },
  products: { type: Array, default: () => [] }, permissions: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({
  product_id: '', name: '', price: 0, duration_days: 30, max_devices: 1, max_shops: 1,
  offline_hours: 0, status: 'active', is_trial: false, permission_ids: [],
  sale_price_yuan: 0, online_sale_enabled: false, license_role: 'legacy',
})
const isShopCard = computed(() => form.license_role !== 'legacy')
const selectedProduct = computed(() => props.products.find((item) => item.id === form.product_id))
const availablePermissions = computed(() => props.permissions.filter((item) => item.project_id === selectedProduct.value?.project_id))
const rules = {
  product_id: [{ required: true, message: '请选择产品', trigger: 'change' }],
  name: [{ required: true, message: '请输入套餐名称', trigger: 'blur' }],
  price: [{ required: true, message: '请输入套餐价格', trigger: 'blur' }],
  duration_days: [{ required: true, message: '请输入有效天数', trigger: 'blur' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  const permissionIds = props.plan?.permission_ids || props.plan?.permissions?.map((item) => item.id) || []
  Object.assign(form, {
    product_id: props.plan?.product_id || props.products[0]?.id || '', name: props.plan?.name || '',
    price: Number(props.plan?.price ?? 0), duration_days: Number(props.plan?.duration_days ?? 30),
    max_devices: Number(props.plan?.max_devices ?? 1), max_shops: Number(props.plan?.max_shops ?? 1),
    offline_hours: Number(props.plan?.offline_hours ?? 0), status: props.plan?.status || 'active',
    is_trial: Boolean(props.plan?.is_trial), permission_ids: [...permissionIds],
    sale_price_yuan: centToYuan(props.plan?.sale_price_cent),
    online_sale_enabled: Boolean(props.plan?.online_sale_enabled),
    license_role: props.plan?.license_role || 'shop_standard_monthly',
  })
  formRef.value?.clearValidate()
})
watch(() => form.license_role, (role) => {
  if (role === 'shop_intro') {
    Object.assign(form, { sale_price_yuan: 19.9, price: 19.9, duration_days: 30, max_shops: 1, is_trial: false })
  } else if (role === 'shop_standard_monthly') {
    Object.assign(form, { sale_price_yuan: 50, price: 50, duration_days: 30, max_shops: 1, is_trial: false })
  } else if (role === 'shop_standard_annual') {
    Object.assign(form, { sale_price_yuan: 600, price: 600, duration_days: 365, max_shops: 1, is_trial: false })
  }
})
function handleProductChange() {
  form.permission_ids = []
}

async function confirm() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (form.online_sale_enabled && yuanToCent(form.sale_price_yuan) <= 0) {
    formRef.value?.scrollToField('sale_price_yuan')
    return
  }
  const { sale_price_yuan: salePriceYuan, ...payload } = form
  emit('submit', {
    ...payload,
    name: form.name.trim(),
    sale_price_cent: yuanToCent(salePriceYuan),
    price: isShopCard.value ? Number(salePriceYuan) : form.price,
  })
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="plan ? '编辑套餐' : '创建套餐'" width="min(680px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid form-grid--2"><el-form-item label="所属产品" prop="product_id"><el-select v-model="form.product_id" filterable placeholder="选择产品" :disabled="Boolean(plan)" @change="handleProductChange"><el-option v-for="item in products" :key="item.id" :label="`${item.name} · ${item.version}`" :value="item.id" /></el-select></el-form-item><el-form-item label="套餐名称" prop="name"><el-input v-model="form.name" placeholder="例如：专业版" /></el-form-item></div>
      <el-form-item label="授权用途" prop="license_role"><el-select v-model="form.license_role" :disabled="Boolean(plan)"><el-option label="首店首月卡（每账号一次）" value="shop_intro" /><el-option label="标准月卡（新店/续费）" value="shop_standard_monthly" /><el-option label="标准年卡（新店/续费）" value="shop_standard_annual" /><el-option label="历史兼容套餐（禁止新制卡）" value="legacy" /></el-select></el-form-item>
      <el-alert v-if="form.license_role === 'shop_intro'" title="首店首月卡固定 19.9 元、30 天、1 个 Ozon 店铺，每个账号终身只能使用一次。" type="warning" :closable="false" show-icon />
      <el-alert v-else-if="form.license_role === 'shop_standard_monthly'" title="标准月卡固定 50 元、30 天、1 个 Ozon 店铺；既可以增加店铺，也可以给原店铺续费。" type="info" :closable="false" show-icon />
      <el-alert v-else-if="form.license_role === 'shop_standard_annual'" title="标准年卡按 50 元/月固定为 600 元、365 天、1 个 Ozon 店铺；可以增加店铺或续费。" type="info" :closable="false" show-icon />
      <div class="form-grid form-grid--4">
        <el-form-item label="价格（元）" prop="price"><el-input-number v-model="form.price" :min="0" :precision="2" :controls="false" :disabled="isShopCard" /></el-form-item>
        <el-form-item label="有效期（天）" prop="duration_days"><el-input-number v-model="form.duration_days" :min="1" :max="36500" :controls="false" :disabled="isShopCard" /></el-form-item>
        <el-form-item label="设备上限" prop="max_devices"><el-input-number v-model="form.max_devices" :min="1" :max="9999" :controls="false" /></el-form-item>
        <el-form-item label="店铺上限" prop="max_shops"><el-input-number v-model="form.max_shops" :min="0" :max="9999" :controls="false" :disabled="isShopCard" /></el-form-item>
      </div>
      <div class="form-grid form-grid--2">
        <el-form-item label="在线售价（元）" prop="sale_price_yuan">
          <el-input-number v-model="form.sale_price_yuan" :min="0" :precision="2" :controls="false" :disabled="isShopCard" />
        </el-form-item>
        <el-form-item label="在线销售" prop="online_sale_enabled">
          <el-switch v-model="form.online_sale_enabled" active-text="已开启" inactive-text="未开启" />
        </el-form-item>
      </div>
      <el-alert v-if="form.online_sale_enabled && yuanToCent(form.sale_price_yuan) <= 0" title="开启在线销售前，在线售价必须大于 0 元。" type="warning" :closable="false" show-icon />
      <div class="form-grid form-grid--3">
        <el-form-item label="允许离线使用（小时）" prop="offline_hours">
          <el-input-number v-model="form.offline_hours" :min="0" :max="168" :controls="false" />
          <span class="field-hint" :class="{ 'field-hint--strict': form.offline_hours === 0 }">
            {{ form.offline_hours === 0 ? '禁止离线使用（必须联网） · 推荐设置' : `断网后最多可继续使用 ${form.offline_hours} 小时` }}
          </span>
        </el-form-item>
        <el-form-item label="套餐状态" prop="status"><el-select v-model="form.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
        <el-form-item label="套餐类型" prop="is_trial"><el-switch v-model="form.is_trial" active-text="试用套餐" inactive-text="正式套餐" /></el-form-item>
      </div>
      <el-form-item label="套餐权限" prop="permission_ids">
        <el-select v-model="form.permission_ids" multiple filterable collapse-tags :max-collapse-tags="3" placeholder="选择同项目下该套餐允许的权限"><el-option v-for="item in availablePermissions" :key="item.id" :label="`${item.name} (${item.code})`" :value="item.id" /></el-select>
      </el-form-item>
      <el-alert title="客户端只能使用服务端在授权检查结果中返回的权限，套餐配置不会在客户端硬编码。" type="info" :closable="false" show-icon />
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="confirm">保存套餐</el-button></template>
  </el-dialog>
</template>

<style scoped>.form-grid{display:grid;gap:16px}.form-grid--2{grid-template-columns:1fr 1fr}.form-grid--3{grid-template-columns:repeat(3,1fr)}.form-grid--4{grid-template-columns:repeat(4,1fr)}.el-select,.el-input-number{width:100%}.field-hint{display:block;margin-top:6px;color:#64748b;font-size:12px;line-height:1.5}.field-hint--strict{color:#dc2626;font-weight:600}@media(max-width:650px){.form-grid--2,.form-grid--3,.form-grid--4{grid-template-columns:1fr 1fr}}@media(max-width:460px){.form-grid--2,.form-grid--3,.form-grid--4{grid-template-columns:1fr}}</style>
