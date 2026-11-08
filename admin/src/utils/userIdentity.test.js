import { describe, expect, it } from 'vitest'
import { userDisplayName } from './userIdentity.js'

describe('userDisplayName', () => {
  it('uses the registered email instead of an internal username', () => {
    expect(userDisplayName({ id: 4, email: '985750000@qq.com', username: 'email_deadbeef' })).toBe('985750000@qq.com')
  })

  it('never exposes a generated username when no email exists', () => {
    expect(userDisplayName({ id: 3, username: 'u_549e8102e4c3c37573b96ca2' })).toBe('未绑定邮箱（用户 #3）')
  })

  it('uses a masked phone for phone-only accounts', () => {
    expect(userDisplayName({ user_id: 8, username: 'u_deadbeef', phone: '13912345678' })).toBe('139****5678')
  })
})
