<script setup>
import { shopsApi } from '../api/admin.js'
import DataListCard from '../components/common/DataListCard.vue'
import PageHeader from '../components/common/PageHeader.vue'

const columns = [
  { prop: 'shop_name', label: '店铺名称', minWidth: 180 },
  { prop: 'platform', label: '平台', minWidth: 110 },
  { prop: 'shop_id', label: '平台店铺 ID', type: 'mono', minWidth: 170 },
  { prop: 'user_id', label: '绑定用户 ID', minWidth: 130 },
  { prop: 'project_id', label: '项目 ID', minWidth: 100 },
  { prop: 'last_sync_time', label: '最后同步', type: 'date', width: 180 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
const platforms = [{ label: 'Ozon', value: 'ozon' }, { label: '淘宝', value: 'taobao' }, { label: '天猫', value: 'tmall' }, { label: '拼多多', value: 'pinduoduo' }]
</script>

<template>
  <div class="page-stack">
    <page-header title="店铺管理" description="统一查看用户绑定的 Ozon、淘宝、天猫及其他平台店铺" />
    <data-list-card :load="shopsApi.list" :remove="shopsApi.remove" :columns="columns" :show-search="false" :status-options="platforms" select-param="platform" select-placeholder="全部平台" delete-title="删除店铺绑定" delete-message="只删除授权中心的店铺绑定记录，不会删除 Ozon 平台店铺。确定继续吗？" />
  </div>
</template>
