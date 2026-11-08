<script setup>
import { computed } from 'vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  channel: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue'])
const token = computed(() => props.channel?.distribution_token || '')

async function copy(value, label) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success(`${label}已复制`)
  } catch {
    ElMessage.warning('浏览器未允许自动复制，请手动选择文本')
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="保存分发凭证" width="min(620px, 92vw)" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="分发 Token 只在本次展示" description="关闭后后台仅保留不可逆摘要。如遗失，请在渠道列表中轮换 Token；旧 Token 会立即失效。" type="warning" :closable="false" show-icon />
    <div class="credential-block">
      <span>渠道码</span><div><code>{{ channel?.code || '—' }}</code><el-button text type="primary" :icon="CopyDocument" @click="copy(channel?.code, '渠道码')">复制</el-button></div>
    </div>
    <div class="credential-block">
      <span>分发 Token</span><div><code class="token">{{ token || '—' }}</code><el-button text type="primary" :icon="CopyDocument" @click="copy(token, '分发 Token')">复制</el-button></div>
    </div>
    <p class="hint">桌面端分发配置只需要保存 <code>channel_code</code> 与 <code>distribution_token</code>，不要把该 Token 上传到公开仓库。</p>
    <template #footer><el-button type="primary" @click="emit('update:modelValue', false)">我已保存</el-button></template>
  </el-dialog>
</template>

<style scoped>
.credential-block{margin-top:16px;padding:14px 16px;border:1px solid var(--lc-border);border-radius:10px;background:#f8faff}.credential-block>span{display:block;margin-bottom:7px;color:var(--lc-muted);font-size:12px}.credential-block>div{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.credential-block code{word-break:break-all}.token{font-size:12px;line-height:1.6}.hint{margin:14px 0 0;color:var(--lc-muted);font-size:12px;line-height:1.7}
</style>
