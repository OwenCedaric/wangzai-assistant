<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDown, Expand, Fold, RefreshRight, SwitchButton } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { findApiEnvironment, setApiEnvironment, useApiEnvironment } from '../api/apiEnvironment.js'
import { clearAuthSession, useAuthSession } from '../auth/authSession.js'
import { appMarkIcon, navigation } from '../config/navigation.js'
import { userDisplayName } from '../utils/userIdentity.js'

const route = useRoute()
const router = useRouter()
const { user } = useAuthSession()
const { environment } = useApiEnvironment()
const collapsed = ref(false)
const mobile = ref(false)
const drawerOpen = ref(false)
const currentPath = computed(() => route.path)
const userLabel = computed(() => userDisplayName(user.value))
const alternateEnvironment = computed(() => findApiEnvironment(environment.value.id === 'test' ? 'primary' : 'test'))

function updateViewport() {
  mobile.value = window.innerWidth < 920
  if (window.innerWidth < 1180) collapsed.value = true
}

async function logout() {
  try {
    await ElMessageBox.confirm('确定退出当前管理账号吗？', '退出登录', {
      confirmButtonText: '退出', cancelButtonText: '取消', type: 'warning',
    })
    clearAuthSession()
    router.replace('/login')
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') throw reason
  }
}

async function switchEnvironment() {
  const target = alternateEnvironment.value
  try {
    await ElMessageBox.confirm(
      `将退出当前账号并切换到“${target.label}”，继续吗？`,
      '切换管理数据范围',
      { confirmButtonText: '切换并重新登录', cancelButtonText: '取消', type: 'warning' },
    )
    clearAuthSession()
    setApiEnvironment(target.id)
    await router.replace({ name: 'login', query: { environment: target.id } })
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') throw reason
  }
}

function handleUnauthorized() {
  if (route.path !== '/login') router.replace({ name: 'login', query: { expired: '1' } })
}

function navigate(path) {
  router.push(path)
  drawerOpen.value = false
}

onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
  window.addEventListener('license-center:unauthorized', handleUnauthorized)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
  window.removeEventListener('license-center:unauthorized', handleUnauthorized)
})
</script>

<template>
  <el-container class="app-shell">
    <el-aside v-if="!mobile" :width="collapsed ? '76px' : '228px'" class="sidebar">
      <div class="brand" :class="{ 'brand--collapsed': collapsed }">
        <el-icon :size="25"><component :is="appMarkIcon" /></el-icon>
        <div v-if="!collapsed"><strong>License</strong><span>Center</span></div>
      </div>
      <el-menu :default-active="currentPath" :collapse="collapsed" class="nav-menu" @select="navigate">
        <el-menu-item v-for="item in navigation" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon><template #title>{{ item.label }}</template>
        </el-menu-item>
      </el-menu>
      <div class="sidebar__footer" :class="{ 'sidebar__footer--collapsed': collapsed }">
        <span v-if="!collapsed">License Center v1.1</span>
        <el-button text circle :aria-label="collapsed ? '展开导航' : '收起导航'" @click="collapsed = !collapsed">
          <el-icon><Expand v-if="collapsed" /><Fold v-else /></el-icon>
        </el-button>
      </div>
    </el-aside>

    <el-drawer v-if="mobile" v-model="drawerOpen" direction="ltr" size="260px" :with-header="false">
      <div class="brand brand--drawer">
        <el-icon :size="25"><component :is="appMarkIcon" /></el-icon><div><strong>License</strong><span>Center</span></div>
      </div>
      <el-menu :default-active="currentPath" class="nav-menu nav-menu--drawer" @select="navigate">
        <el-menu-item v-for="item in navigation" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon><template #title>{{ item.label }}</template>
        </el-menu-item>
      </el-menu>
    </el-drawer>

    <el-container class="main-frame">
      <el-header class="topbar">
        <div class="topbar__left">
          <el-button v-if="mobile" text circle aria-label="打开导航" @click="drawerOpen = true"><el-icon><Expand /></el-icon></el-button>
          <div><strong>{{ route.meta.title }}</strong><span>通用软件授权管理平台</span></div>
        </div>
        <div class="topbar__actions">
          <el-tag :type="environment.tagType" effect="dark" round>{{ environment.label }}</el-tag>
          <el-dropdown trigger="click">
            <button class="user-menu" type="button">
              <el-avatar :size="34">{{ userLabel.slice(0, 1).toUpperCase() }}</el-avatar>
              <span>{{ userLabel }}</span><el-icon><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item :icon="RefreshRight" @click="switchEnvironment">切换至{{ alternateEnvironment.label }}</el-dropdown-item>
                <el-dropdown-item divided :icon="SwitchButton" @click="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="content"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.app-shell { min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; z-index: 20; display: flex; flex-direction: column; background: #101828; transition: width .22s ease; overflow: hidden; }
.brand { height: 68px; flex: 0 0 68px; display: flex; align-items: center; gap: 11px; padding: 0 21px; color: white; }
.brand .el-icon { color: #7fa0ff; }
.brand div { display: flex; gap: 5px; font-size: 18px; white-space: nowrap; }
.brand strong { letter-spacing: -.02em; }.brand span { color: #8ea1bc; }
.brand--collapsed { justify-content: center; padding: 0; }
.brand--drawer { background: #101828; margin: -20px -20px 12px; }
.nav-menu { flex: 1; border-right: 0; background: transparent; padding: 10px 12px; overflow-y: auto; }
.nav-menu :deep(.el-menu-item) { height: 46px; margin-bottom: 5px; border-radius: 9px; color: #9facbf; }
.nav-menu :deep(.el-menu-item:hover) { background: #19243a; color: white; }
.nav-menu :deep(.el-menu-item.is-active) { color: white; background: #315efb; }
.nav-menu :deep(.el-menu-item .el-icon) { font-size: 18px; }
.nav-menu--drawer { background: white; }
.nav-menu--drawer :deep(.el-menu-item) { color: #566176; }
.sidebar__footer { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-top: 1px solid #253047; color: #70809b; font-size: 11px; white-space: nowrap; }
.sidebar__footer .el-button { color: #9facbf; }.sidebar__footer--collapsed { justify-content: center; }
.main-frame { min-width: 0; margin-left: 228px; transition: margin-left .22s ease; }
.sidebar[style*="76px"] + .main-frame { margin-left: 76px; }
.topbar { position: sticky; top: 0; z-index: 15; height: 68px; display: flex; align-items: center; justify-content: space-between; padding: 0 28px; background: rgb(255 255 255 / 92%); border-bottom: 1px solid var(--lc-border); backdrop-filter: blur(12px); }
.topbar__left { display: flex; min-width: 0; align-items: center; gap: 8px; }.topbar__left div { display: flex; min-width: 0; flex-direction: column; }
.topbar__left strong { font-size: 16px; }.topbar__left span { margin-top: 3px; color: #939cad; font-size: 11px; }
.topbar__actions { display: flex; align-items: center; gap: 10px; }
.user-menu { display: flex; min-width: 0; max-width: 320px; align-items: center; gap: 9px; padding: 5px 8px; color: var(--lc-text); background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
.user-menu > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-menu:hover { background: #f4f6fa; }.user-menu .el-avatar { color: #315efb; background: #e9efff; font-weight: 700; }
.content { min-width: 0; padding: 26px 28px 40px; overflow: visible; }
@media (max-width: 919px) { .main-frame { margin-left: 0 !important; }.content { padding: 22px 16px 36px; }.topbar { padding: 0 14px; } }
@media (max-width: 520px) { .topbar__left span, .user-menu > span { display: none; }.topbar__actions { gap: 4px; }.topbar__actions .el-tag { max-width: 96px; overflow: hidden; text-overflow: ellipsis; } }
</style>
