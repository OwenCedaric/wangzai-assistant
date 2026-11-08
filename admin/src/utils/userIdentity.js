import { maskedPhone } from './commerce.js'

export function userDisplayName(user) {
  if (!user) return '未知用户'
  const email = String(user.email || '').trim()
  if (email) return email
  const phone = user.phone_masked || user.phone
  if (phone) return maskedPhone(phone)
  if (user.is_admin) return '管理员'
  const id = user.user_id ?? user.id
  return id ? `未绑定邮箱（用户 #${id}）` : '未绑定邮箱'
}
