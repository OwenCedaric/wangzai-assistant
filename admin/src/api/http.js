import axios from 'axios'
import { clearAuthSession, getAccessToken } from '../auth/authSession.js'
import { getActiveApiBaseUrl } from './apiEnvironment.js'

const configuredTimeout = Number(import.meta.env.VITE_API_TIMEOUT)

export const http = axios.create({
  timeout: Number.isFinite(configuredTimeout) ? configuredTimeout : 12000,
  headers: { 'Content-Type': 'application/json' },
})

http.interceptors.request.use((config) => {
  config.baseURL = getActiveApiBaseUrl()
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      clearAuthSession()
      window.dispatchEvent(new CustomEvent('license-center:unauthorized'))
    }
    return Promise.reject(error)
  },
)
