import { computed, readonly, ref } from 'vue'

// Token 仅保存在当前页面内存中，刷新或关闭页面后自动失效。
const accessToken = ref('')
const currentUser = ref(null)

export function setAuthSession(payload) {
  accessToken.value = typeof payload?.access_token === 'string' ? payload.access_token : ''
  currentUser.value = payload?.user && typeof payload.user === 'object' ? payload.user : null
}

export function clearAuthSession() {
  accessToken.value = ''
  currentUser.value = null
}

export function getAccessToken() {
  return accessToken.value
}

export function hasAuthSession() {
  return Boolean(accessToken.value)
}

export function useAuthSession() {
  return {
    accessToken: readonly(accessToken),
    user: readonly(currentUser),
    isAuthenticated: computed(() => Boolean(accessToken.value)),
    setSession: setAuthSession,
    clearSession: clearAuthSession,
  }
}
