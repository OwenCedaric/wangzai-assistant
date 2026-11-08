<script setup>
import { computed, reactive, ref } from 'vue'
import { Lock, User } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { apiEnvironments, findApiEnvironment, setApiEnvironment } from '../api/apiEnvironment.js'
import { login } from '../api/auth.js'
import { getApiError } from '../api/response.js'
import { setAuthSession } from '../auth/authSession.js'

const router = useRouter()
const route = useRoute()
const formRef = ref()
const loading = ref(false)
const initialEnvironment = findApiEnvironment(route.query.environment).id
const form = reactive({ username: '', password: '', environment: initialEnvironment })
setApiEnvironment(initialEnvironment)
const rules = {
  username: [{ required: true, message: '请输入管理员账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}
const sessionExpired = computed(() => route.query.expired === '1')
const selectedEnvironment = computed(() => findApiEnvironment(form.environment))

function selectEnvironment(environmentId) {
  setApiEnvironment(environmentId)
}

async function submit() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    setApiEnvironment(form.environment)
    const identifier = form.username.trim()
    const result = await login({
      [identifier.includes('@') ? 'email' : 'username']: identifier,
      password: form.password,
    })
    if (!result?.access_token) throw new Error('登录响应缺少 access_token')
    if (!result.user?.is_admin) throw new Error('当前账号无管理员权限')
    setAuthSession(result)
    ElMessage.success(`已进入${selectedEnvironment.value.label}`)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') && !route.query.redirect.startsWith('//')
      ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (error) {
    ElMessage.error(getApiError(error, '登录失败，请检查账号和密码'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-visual">
      <div class="login-visual__glow" />
      <div class="visual-content">
        <div class="logo-mark">LC</div>
        <p class="eyebrow">UNIFIED SOFTWARE LICENSING</p>
        <h1>让每一款软件<br />共享一套授权基础设施</h1>
        <p class="intro">开发版与测试版使用同一套管理界面，账号、授权和业务数据仍按环境严格隔离。</p>
        <div class="visual-points">
          <span>服务端权限控制</span><span>标准 project.json</span><span>跨软件复用</span>
        </div>
      </div>
    </section>
    <section class="login-panel">
      <div class="login-card">
        <div class="mobile-logo"><span>LC</span> License Center</div>
        <p class="eyebrow eyebrow--blue">ADMIN CONSOLE</p>
        <h2>欢迎回来</h2>
        <p class="subtitle">登录 License Center 管理后台</p>
        <el-alert v-if="sessionExpired" title="登录已失效，请重新登录" type="warning" :closable="false" show-icon />
        <div class="environment-field">
          <span class="environment-field__label">管理数据范围</span>
          <el-radio-group v-model="form.environment" class="environment-options" @change="selectEnvironment">
            <el-radio-button v-for="item in apiEnvironments" :key="item.id" :value="item.id">
              {{ item.label }}
            </el-radio-button>
          </el-radio-group>
          <p>{{ selectedEnvironment.description }}</p>
        </div>
        <el-alert
          v-if="form.environment === 'test'"
          title="当前操作只会写入测试版隔离数据库"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @keyup.enter="submit">
          <el-form-item label="管理员邮箱或账号" prop="username">
            <el-input v-model="form.username" :prefix-icon="User" autocomplete="username" placeholder="请输入邮箱或账号" />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input v-model="form.password" :prefix-icon="Lock" type="password" autocomplete="current-password" placeholder="请输入密码" show-password />
          </el-form-item>
          <el-button type="primary" size="large" :loading="loading" class="submit-button" @click="submit">
            登录{{ selectedEnvironment.shortLabel }}管理
          </el-button>
        </el-form>
        <p class="security-note">Access Token 仅保留在当前页面内存中，刷新后需重新登录。</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-page { min-height: 100vh; display: grid; grid-template-columns: minmax(440px, 1.1fr) minmax(440px, .9fr); background: white; }
.login-visual { position: relative; display: flex; align-items: center; padding: 8vw; overflow: hidden; color: white; background: linear-gradient(145deg, #101828 0%, #152448 60%, #1d3f91 100%); }
.login-visual::after { content: ""; position: absolute; width: 420px; height: 420px; right: -170px; bottom: -190px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 50%; box-shadow: 0 0 0 70px rgb(255 255 255 / 3%), 0 0 0 140px rgb(255 255 255 / 2%); }
.login-visual__glow { position: absolute; inset: -30% auto auto -20%; width: 500px; height: 500px; background: #315efb; border-radius: 50%; filter: blur(120px); opacity: .28; }
.visual-content { position: relative; z-index: 1; max-width: 590px; }
.logo-mark { width: 54px; height: 54px; display: grid; place-items: center; margin-bottom: 52px; border: 1px solid rgb(255 255 255 / 20%); border-radius: 15px; color: #aabfff; background: rgb(255 255 255 / 8%); font-weight: 800; }
.eyebrow { margin: 0 0 16px; color: #8facff; font-size: 11px; font-weight: 700; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(34px, 4vw, 55px); line-height: 1.2; letter-spacing: -.045em; }
.intro { max-width: 520px; margin: 26px 0 34px; color: #aebbd1; font-size: 16px; line-height: 1.8; }
.visual-points { display: flex; flex-wrap: wrap; gap: 10px; }.visual-points span { padding: 8px 12px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 99px; color: #c3cee1; background: rgb(255 255 255 / 5%); font-size: 12px; }
.login-panel { display: grid; place-items: center; padding: 40px; }.login-card { width: min(400px, 100%); }
.mobile-logo { display: none; }.eyebrow--blue { color: #315efb; }h2 { margin: 0; color: #101828; font-size: 31px; letter-spacing: -.03em; }.subtitle { margin: 10px 0 30px; color: var(--lc-muted); }
.el-alert { margin-bottom: 20px; }.el-form-item { margin-bottom: 22px; }.submit-button { width: 100%; height: 46px; margin-top: 4px; font-weight: 600; }
.environment-field { margin: 0 0 20px; }.environment-field__label { display: block; margin-bottom: 9px; color: var(--lc-text); font-size: 14px; font-weight: 600; }
.environment-options { display: flex; width: 100%; }.environment-options :deep(.el-radio-button) { flex: 1; }.environment-options :deep(.el-radio-button__inner) { width: 100%; }
.environment-field p { margin: 8px 0 0; color: var(--lc-muted); font-size: 12px; line-height: 1.55; }
.security-note { margin: 24px 0 0; text-align: center; color: #a1a9b6; font-size: 11px; line-height: 1.6; }
@media (max-width: 860px) { .login-page { grid-template-columns: 1fr; background: #f5f7fb; }.login-visual { display: none; }.login-panel { min-height: 100vh; padding: 24px; }.login-card { padding: 28px; border: 1px solid var(--lc-border); border-radius: 18px; background: white; box-shadow: var(--lc-shadow); }.mobile-logo { display: flex; align-items: center; gap: 10px; margin-bottom: 38px; font-weight: 700; }.mobile-logo span { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: white; background: #315efb; font-size: 12px; } }
</style>
