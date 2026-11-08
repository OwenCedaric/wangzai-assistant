<script setup>
import { computed, ref, watch } from 'vue'
import { DocumentAdd, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { parseProjectManifest } from '../../utils/projectManifest.js'

const props = defineProps({ modelValue: { type: Boolean, default: false }, submitting: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'submit'])
const content = ref('')
const parsed = ref(null)
const error = ref('')
const moduleNames = computed(() => parsed.value?.modules?.map((item) => typeof item === 'string' ? item : item.name) || [])

watch(() => props.modelValue, (visible) => {
  if (visible) { content.value = ''; parsed.value = null; error.value = '' }
})

async function handleFile(file) {
  const raw = file.raw
  if (!raw || !raw.name.toLowerCase().endsWith('.json')) { ElMessage.warning('请选择 .json 文件'); return }
  if (raw.size > 1024 * 1024) { ElMessage.warning('project.json 不能超过 1MB'); return }
  content.value = await raw.text()
  preview()
}

function preview() {
  try {
    parsed.value = parseProjectManifest(content.value)
    error.value = ''
  } catch (exception) {
    parsed.value = null
    error.value = exception.message
  }
}

function confirm() {
  preview()
  if (parsed.value) emit('submit', parsed.value)
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="导入 project.json" width="min(680px, 92vw)" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="系统将根据标准清单创建项目，并把 modules 转换为可配置权限。导入前不会扫描源码。" type="info" :closable="false" show-icon />
    <el-upload drag :auto-upload="false" accept="application/json,.json" :show-file-list="false" class="manifest-upload" :on-change="handleFile">
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon><div class="el-upload__text">拖入 project.json，或<em>选择文件</em></div>
    </el-upload>
    <el-input v-model="content" type="textarea" :rows="9" class="manifest-input mono" placeholder="也可以在此粘贴 project.json 内容" @blur="content && preview()" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="validation-message" />
    <div v-if="parsed" class="manifest-preview">
      <div class="preview-title"><el-icon><DocumentAdd /></el-icon><strong>{{ parsed.name }}</strong><span>{{ parsed.code }} · {{ parsed.version }}</span></div>
      <div class="module-list"><span v-for="item in moduleNames" :key="item">{{ item }}</span><em v-if="!moduleNames.length">无功能模块</em></div>
    </div>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button @click="preview">校验预览</el-button><el-button type="primary" :loading="submitting" @click="confirm">确认导入</el-button></template>
  </el-dialog>
</template>

<style scoped>
.manifest-upload { margin: 18px 0 14px; }.manifest-upload :deep(.el-upload-dragger) { padding: 22px; }.manifest-upload :deep(.el-icon--upload) { margin-bottom: 4px; font-size: 38px; }.manifest-input :deep(textarea) { font-size: 12px; line-height: 1.6; }.validation-message { margin-top: 12px; }.manifest-preview { margin-top: 14px; padding: 14px; border: 1px solid #cddaff; border-radius: 10px; background: #f4f7ff; }.preview-title { display: flex; align-items: center; gap: 8px; }.preview-title .el-icon { color: #315efb; }.preview-title span { color: var(--lc-muted); font-size: 12px; }.module-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }.module-list span { padding: 5px 9px; border-radius: 6px; color: #315efb; background: white; font-size: 12px; }.module-list em { color: var(--lc-muted); font-size: 12px; }
</style>
