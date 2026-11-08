<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  provider: { type: Object, default: null },
  submitting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ base_url: '' })
const rules = {
  base_url: [
    { required: true, message: '请输入新的 HTTPS API 地址', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        try {
          const url = new URL(value)
          if (url.protocol !== 'https:') throw new Error('invalid protocol')
          callback()
        } catch {
          callback(new Error('请输入完整的 HTTPS API 地址'))
        }
      },
      trigger: 'blur',
    },
  ],
}

watch(() => props.modelValue, (visible) => {
  if (visible) form.base_url = props.provider?.base_url || ''
})

async function submit() {
  await formRef.value?.validate()
  emit('submit', { base_url: form.base_url.trim() })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="更换接口地址"
    width="min(600px, 94vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="provider-name">{{ provider?.name || '当前接口' }}</div>
    <el-alert
      title="保存时会用现有 Key 实测新地址并核对当前模型。验证通过后，下一次调用立即生效，桌面端无需更新。"
      type="info"
      :closable="false"
      show-icon
    />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="endpoint-form">
      <el-form-item label="新的 API 根地址" prop="base_url">
        <el-input v-model="form.base_url" placeholder="https://new-api.example.com/v1" clearable />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">验证并立即切换</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.provider-name{margin-bottom:12px;font-size:16px;font-weight:700;color:#172033}.endpoint-form{margin-top:18px}
</style>
