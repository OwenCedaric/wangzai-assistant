<script setup>
import { computed, ref } from 'vue'
import { CopyDocument, Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ modelValue: { type: Boolean, default: false }, batch: { type: Object, default: null }, exporting: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'export'])
const copying = ref(false)
const codes = computed(() => Array.isArray(props.batch?.codes) ? props.batch.codes : [])
const retentionNotice = computed(() => props.batch?.export_available
  ? '完整卡密已加密保存，可在卡密明细中再次查看；复制或导出后请通过安全渠道交付。'
  : '当前未启用卡密加密保存，关闭后将无法再次查看完整卡密；请先复制并通过安全渠道交付。')

async function copyAll() {
  copying.value = true
  try {
    await navigator.clipboard.writeText(codes.value.join('\n'))
    ElMessage.success(`已复制 ${codes.value.length} 个卡密`)
  } catch {
    ElMessage.error('复制失败，请使用服务端导出')
  } finally { copying.value = false }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="卡密生成成功" width="min(680px, 92vw)" :close-on-click-modal="false" @update:model-value="emit('update:modelValue', $event)">
    <el-alert :title="retentionNotice" type="warning" :closable="false" show-icon />
    <div class="result-summary"><div><span>批次</span><strong>{{ batch?.name || `#${batch?.id}` }}</strong></div><div><span>生成数量</span><strong>{{ codes.length }}</strong></div><div><span>授权天数</span><strong>{{ batch?.duration_days || '按套餐' }}</strong></div></div>
    <div class="codes-list"><code v-for="code in codes" :key="code">{{ code }}</code></div>
    <template #footer><el-button :icon="CopyDocument" :loading="copying" @click="copyAll">复制全部</el-button><el-dropdown v-if="batch?.export_available" @command="emit('export', $event)"><el-button :icon="Download" :loading="exporting">服务端导出</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="csv">导出 CSV</el-dropdown-item><el-dropdown-item command="xlsx">导出 Excel</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button type="primary" @click="emit('update:modelValue', false)">完成</el-button></template>
  </el-dialog>
</template>

<style scoped>.result-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.result-summary>div{padding:12px;border-radius:9px;background:#f5f7fb}.result-summary span{display:block;color:var(--lc-muted);font-size:11px}.result-summary strong{display:block;margin-top:6px;font-size:14px}.codes-list{max-height:330px;display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:12px;overflow:auto;border:1px solid var(--lc-border);border-radius:10px;background:#fafbfc}.codes-list code{padding:7px 9px;border-radius:6px;color:#172033;background:white;font-size:12px}@media(max-width:580px){.result-summary,.codes-list{grid-template-columns:1fr}}</style>
