<template>
  <main class="not-found">
    <el-result icon="warning" title="页面不存在" sub-title="你访问的页面可能已移动或删除">
      <template #extra><el-button type="primary" @click="$router.replace('/dashboard')">返回工作台</el-button></template>
    </el-result>
  </main>
</template>

<style scoped>.not-found { min-height: 100vh; display: grid; place-items: center; background: #f4f6fa; }</style>
