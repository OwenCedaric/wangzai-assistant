<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  agent: { type: Object, default: null },
  projects: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({
  code: '', name: '', contact_name: '', contact_phone: '', commission_rate_percent: 0,
  project_ids: [], status: 'active',
})
const editing = computed(() => Boolean(props.agent?.id))
const rules = {
  code: [
    { required: true, message: '请输入代理编号', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9_-]{2,40}$/, message: '仅支持字母、数字、下划线和短横线', trigger: 'blur' },
  ],
  name: [{ required: true, message: '请输入代理名称', trigger: 'blur' }],
  contact_phone: [{ pattern: /^$|^1\d{10}$/, message: '请输入正确的手机号', trigger: 'blur' }],
}

function resetForm() {
  const source = props.agent || {}
  Object.assign(form, {
    code: source.code || '',
    name: source.name || '',
    contact_name: source.contact_name || '',
    contact_phone: source.contact_phone?.includes('*') ? '' : source.contact_phone || '',
    commission_rate_percent: Number(source.default_commission_rate_bps || 0) / 100,
    project_ids: Array.isArray(source.project_ids) ? [...source.project_ids] : [],
    status: source.status || 'active',
  })
  formRef.value?.clearValidate()
}

async function submit() {
  await formRef.value.validate()
  const payload = {
    code: form.code.trim().toUpperCase(),
    name: form.name.trim(),
    contact_name: form.contact_name.trim() || null,
    contact_phone: form.contact_phone.trim() || null,
    default_commission_rate_bps: Math.round(Number(form.commission_rate_percent || 0) * 100),
    project_ids: [...form.project_ids],
    status: form.status,
  }
  if (editing.value && !form.contact_phone.trim() && props.agent?.contact_phone) delete payload.contact_phone
  emit('submit', payload)
}

watch(() => props.modelValue, (visible) => { if (visible) resetForm() })
watch(() => props.agent, () => { if (props.modelValue) resetForm() })
</script>

<template>
  <el-dialog :model-value="modelValue" :title="editing ? '编辑代理' : '新增代理'" width="min(620px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <div class="form-grid">
        <el-form-item label="代理编号" prop="code">
          <el-input v-model="form.code" :disabled="editing" maxlength="40" placeholder="例如 AGT_00018" />
        </el-form-item>
        <el-form-item label="代理名称" prop="name">
          <el-input v-model="form.name" maxlength="80" placeholder="用于后台识别" />
        </el-form-item>
        <el-form-item label="联系人" prop="contact_name">
          <el-input v-model="form.contact_name" maxlength="50" placeholder="选填" />
        </el-form-item>
        <el-form-item label="联系电话" prop="contact_phone">
          <el-input v-model="form.contact_phone" maxlength="11" :placeholder="editing ? '留空则不修改已脱敏号码' : '选填'" />
        </el-form-item>
        <el-form-item label="默认佣金比例" prop="commission_rate_percent">
          <el-input-number v-model="form.commission_rate_percent" :min="0" :max="100" :precision="2" :step="0.5" controls-position="right" />
          <span class="unit">%</span>
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="form.status"><el-radio-button value="active">正常</el-radio-button><el-radio-button value="disabled">禁用</el-radio-button></el-radio-group>
        </el-form-item>
      </div>
      <el-form-item label="可销售项目" prop="project_ids">
        <el-select v-model="form.project_ids" multiple filterable clearable placeholder="未选择时不允许创建该项目渠道" style="width:100%">
          <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存代理</el-button></template>
  </el-dialog>
</template>

<style scoped>
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.unit{margin-left:8px;color:var(--lc-muted)}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}}
</style>
