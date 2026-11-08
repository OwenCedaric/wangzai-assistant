<script setup>
import { usageLogsApi } from '../api/admin.js'
import DataListCard from '../components/common/DataListCard.vue'
import PageHeader from '../components/common/PageHeader.vue'

const columns = [
  { prop: 'created_at', label: '发生时间', type: 'date', width: 180 },
  { prop: 'user_id', label: '用户 ID', minWidth: 100 },
  { prop: 'project_id', label: '项目 ID', minWidth: 100 },
  { prop: 'event', label: '事件', type: 'mono', minWidth: 200 },
  { prop: 'details', label: '事件详情', type: 'json', minWidth: 280 },
]
</script>

<template>
  <div class="page-stack">
    <page-header title="使用日志" description="查看登录、软件启动、同步与功能调用等审计事件" />
    <data-list-card :load="usageLogsApi.list" :remove="usageLogsApi.remove" :columns="columns" search-param="event" search-placeholder="输入完整事件代码筛选" delete-title="删除使用日志" delete-message="永久删除这条使用日志？" />
  </div>
</template>
