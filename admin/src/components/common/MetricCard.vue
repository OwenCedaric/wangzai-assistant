<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: 0 },
  note: { type: String, default: '' },
  tone: { type: String, default: 'blue' },
})
</script>

<template>
  <el-card shadow="never" class="metric-card surface-card" :class="`metric-card--${tone}`">
    <div class="metric-card__top">
      <span>{{ label }}</span>
      <span class="metric-card__dot" />
    </div>
    <strong>{{ value }}</strong>
    <small v-if="note">{{ note }}</small>
  </el-card>
</template>

<style scoped>
.metric-card { min-width: 0; }
.metric-card :deep(.el-card__body) { padding: 18px 20px; }
.metric-card__top { display: flex; align-items: center; justify-content: space-between; color: var(--lc-muted); font-size: 13px; }
.metric-card__dot { width: 9px; height: 9px; border-radius: 50%; background: #315efb; box-shadow: 0 0 0 6px #edf2ff; }
strong { display: block; margin-top: 16px; font-size: 27px; line-height: 1.1; color: var(--lc-text); }
small { display: block; margin-top: 8px; color: #9099aa; }
.metric-card--green .metric-card__dot { background: #20a67a; box-shadow: 0 0 0 6px #e9f8f2; }
.metric-card--orange .metric-card__dot { background: #f39b32; box-shadow: 0 0 0 6px #fff4e6; }
.metric-card--purple .metric-card__dot { background: #7c5ce7; box-shadow: 0 0 0 6px #f1edff; }
.metric-card--red .metric-card__dot { background: #e85b65; box-shadow: 0 0 0 6px #ffedef; }
</style>
