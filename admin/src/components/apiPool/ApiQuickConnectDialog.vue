<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  submitting: Boolean,
  initialUrl: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref()
const form = reactive({ base_url: '', api_key: '' })
const rules = {
  base_url: [
    { required: true, message: '请输入接口网址', trigger: 'blur' },
    { type: 'url', message: '请输入完整的 HTTPS 网址', trigger: 'blur' },
  ],
  api_key: [{ required: true, min: 8, message: '请输入完整 API Key', trigger: 'blur' }],
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  Object.assign(form, { base_url: props.initialUrl || '', api_key: '' })
})

async function submit() {
  await formRef.value?.validate()
  emit('submit', { base_url: form.base_url.trim(), api_key: form.api_key.trim() })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="添加 API"
    width="min(560px, 94vw)"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      title="只需要填写接口网址和 API Key。系统会自动纠正网址、验证 Key、识别模型并加入密钥池。"
      type="success"
      :closable="false"
      show-icon
    />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="quick-form">
      <el-form-item label="接口网址" prop="base_url">
        <el-input v-model="form.base_url" placeholder="例如 https://api.example.com/v1" clearable />
        <div class="field-tip">粘贴中转站的 /keys 页面也可以，系统会尝试自动找到真实 API 地址。</div>
      </el-form-item>
      <el-form-item label="API Key" prop="api_key">
        <el-input
          v-model="form.api_key"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="粘贴完整 API Key"
        />
        <div class="field-tip">Key 只会发送给本机后端加密保存，页面不会再次显示明文。</div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">自动识别并接入</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.quick-form{margin-top:20px}.field-tip{margin-top:6px;color:var(--lc-muted);font-size:12px;line-height:1.55}
</style>
