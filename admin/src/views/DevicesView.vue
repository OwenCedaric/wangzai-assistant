<script setup>
import { devicesApi } from '../api/admin.js'
import DataListCard from '../components/common/DataListCard.vue'
import PageHeader from '../components/common/PageHeader.vue'

const columns = [
  { prop: 'device_code', label: '设备代码', type: 'mono', minWidth: 230 },
  { prop: 'device_name', label: '设备名称', minWidth: 170 },
  { prop: 'user_id', label: '绑定用户 ID', minWidth: 130 },
  { prop: 'project_id', label: '项目 ID', minWidth: 100 },
  { prop: 'last_login', label: '最后登录', type: 'date', width: 180 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
</script>

<template>
  <div class="page-stack">
    <page-header title="设备管理" description="查看账号绑定的客户端设备与最近登录状态" />
    <data-list-card :load="devicesApi.list" :remove="devicesApi.remove" :columns="columns" search-param="user_id" search-placeholder="输入用户 ID 筛选" delete-title="删除设备" delete-message="删除后该设备绑定会立即解除，客户端下次使用时需要重新绑定。" />
  </div>
</template>
