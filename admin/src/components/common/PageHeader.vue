<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
})
</script>

<template>
  <header class="page-header">
    <div>
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 20px; }
.page-header > div:first-child { min-width: 0; }
h1 { margin: 0; font-size: 24px; line-height: 1.4; letter-spacing: -.02em; color: var(--lc-text); }
p { margin: 6px 0 0; font-size: 14px; line-height: 1.6; color: var(--lc-muted); }
.page-header__actions { display: flex; min-width: 0; flex: 0 1 auto; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.page-header__actions > * { flex: 0 0 auto; }
@media (max-width: 820px) {
  .page-header { flex-direction: column; }
  .page-header__actions { width: 100%; justify-content: flex-start; }
}
</style>
