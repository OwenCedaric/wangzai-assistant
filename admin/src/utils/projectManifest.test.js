import { describe, expect, it } from 'vitest'
import { parseProjectManifest, validateProjectManifest } from './projectManifest.js'

describe('projectManifest', () => {
  it('parses the standard project.json shape', () => {
    const result = parseProjectManifest(JSON.stringify({
      name: '通用运营助手',
      code: 'operation_helper',
      version: '1.0.0',
      modules: ['订单管理', { code: 'profit', name: '利润分析' }],
    }))

    expect(result.code).toBe('operation_helper')
    expect(result.modules).toEqual([
      '订单管理',
      { code: 'profit', name: '利润分析', description: '' },
    ])
  })

  it('rejects invalid project codes', () => {
    expect(() => validateProjectManifest({
      name: '测试', code: 'Bad-Code', version: '1.0.0', modules: [],
    })).toThrow('code 需以小写字母开头')
  })

  it('rejects malformed JSON without exposing parser details', () => {
    expect(() => parseProjectManifest('{bad json')).toThrow('project.json 不是有效的 JSON')
  })
})
