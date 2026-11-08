import { endpoints } from './endpoints.js'
import { http } from './http.js'
import { normalizeItem } from './response.js'

export async function login(credentials) {
  return normalizeItem(await http.post(endpoints.auth.login, credentials))
}
