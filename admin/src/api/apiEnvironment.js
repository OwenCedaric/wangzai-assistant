import { computed, readonly, ref } from 'vue'

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export const apiEnvironments = Object.freeze([
  Object.freeze({
    id: 'primary',
    label: '开发版数据',
    shortLabel: '开发版',
    description: '当前开发版账号、授权、店铺、订单和模型任务',
    baseURL: normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL),
    tagType: 'primary',
  }),
  Object.freeze({
    id: 'test',
    label: '测试版数据',
    shortLabel: '测试版',
    description: '对外测试账号、授权、积分和测试产生的业务数据',
    baseURL: normalizeBaseUrl(import.meta.env.VITE_TEST_API_BASE_URL || '/test-runtime'),
    tagType: 'warning',
  }),
])

const defaultEnvironment = apiEnvironments[0]
const activeEnvironmentId = ref(defaultEnvironment.id)

export function findApiEnvironment(environmentId) {
  return apiEnvironments.find((item) => item.id === environmentId) || defaultEnvironment
}

export function setApiEnvironment(environmentId) {
  activeEnvironmentId.value = findApiEnvironment(environmentId).id
  return getApiEnvironment()
}

export function getApiEnvironmentId() {
  return activeEnvironmentId.value
}

export function getApiEnvironment() {
  return findApiEnvironment(activeEnvironmentId.value)
}

export function getActiveApiBaseUrl() {
  return getApiEnvironment().baseURL
}

export function useApiEnvironment() {
  return {
    environmentId: readonly(activeEnvironmentId),
    environment: computed(() => getApiEnvironment()),
    environments: apiEnvironments,
    setEnvironment: setApiEnvironment,
  }
}
