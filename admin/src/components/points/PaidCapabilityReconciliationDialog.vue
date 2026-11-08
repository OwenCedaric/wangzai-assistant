<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  job: { type: Object, default: null },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({
  decision: 'release_unbilled',
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  units: 0,
  provider_request_id: '',
  note: '',
})
const settlesUsage = computed(() => form.decision === 'settle_billed')
const rules = {
  note: [
    { required: true, message: '请填写供应商核对依据', trigger: 'blur' },
    { min: 3, max: 500, message: '核对依据需为 3–500 个字符', trigger: 'blur' },
  ],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, {
    decision: 'release_unbilled',
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    units: 0,
    provider_request_id: '',
    note: '',
  })
  formRef.value?.clearValidate()
})

async function confirm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  emit('submit', {
    decision: form.decision,
    input_tokens: settlesUsage.value ? Number(form.input_tokens) : 0,
    output_tokens: settlesUsage.value ? Number(form.output_tokens) : 0,
    cached_input_tokens: settlesUsage.value ? Number(form.cached_input_tokens) : 0,
    units: settlesUsage.value ? Number(form.units) : 0,
    provider_request_id: settlesUsage.value && form.provider_request_id.trim()
      ? form.provider_request_id.trim()
      : null,
    note: form.note.trim(),
  })
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="人工核对付费任务" width="min(700px, 94vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="只在供应商后台确认结果后处理。错误释放会造成上游已扣费但用户未扣积分；错误结算会损害用户余额。" type="error" :closable="false" show-icon />
    <div v-if="job" class="job-summary">
      <strong>{{ job.capability }}</strong>
      <span>任务 {{ job.id }}</span>
      <span>用户 #{{ job.user_id }} · 项目 #{{ job.project_id }} · 预占 {{ Number(job.reserved_points || 0).toLocaleString('zh-CN') }} 积分</span>
    </div>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="核对结论">
        <el-radio-group v-model="form.decision">
          <el-radio-button value="release_unbilled">供应商未计费，释放积分</el-radio-button>
          <el-radio-button value="settle_billed">供应商已计费，按用量结算</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <div v-if="settlesUsage" class="usage-grid">
        <el-form-item label="输入 Token"><el-input-number v-model="form.input_tokens" :min="0" :max="2000000000" :controls="false" /></el-form-item>
        <el-form-item label="输出 Token"><el-input-number v-model="form.output_tokens" :min="0" :max="2000000000" :controls="false" /></el-form-item>
        <el-form-item label="缓存输入 Token"><el-input-number v-model="form.cached_input_tokens" :min="0" :max="2000000000" :controls="false" /></el-form-item>
        <el-form-item label="计费单位（张/次）"><el-input-number v-model="form.units" :min="0" :max="2000000000" :controls="false" /></el-form-item>
      </div>
      <el-form-item v-if="settlesUsage" label="供应商请求号（可选，仅保存 SHA-256 摘要）"><el-input v-model="form.provider_request_id" maxlength="512" autocomplete="off" /></el-form-item>
      <el-form-item label="供应商核对依据" prop="note"><el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="例如：已在供应商账单确认本次请求未产生费用。不要填写密钥、令牌或密码。" /></el-form-item>
      <el-alert title="核对依据只保存 SHA-256 摘要，不保存原文；提交后不可重复处理。" type="info" :closable="false" show-icon />
    </el-form>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button :type="settlesUsage ? 'danger' : 'warning'" :loading="submitting" @click="confirm">确认并永久处理</el-button></template>
  </el-dialog>
</template>

<style scoped>
.job-summary{display:flex;flex-direction:column;gap:5px;margin:16px 0;padding:13px 15px;border-radius:10px;background:#f5f7fb}.job-summary span{color:var(--lc-muted);overflow-wrap:anywhere}.usage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.el-input-number{width:100%}@media(max-width:600px){.usage-grid{grid-template-columns:1fr}}
</style>
