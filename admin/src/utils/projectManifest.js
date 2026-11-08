const CODE_PATTERN = /^[a-z][a-z0-9_.-]{1,95}$/

export function parseProjectManifest(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请粘贴或选择 project.json')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('project.json 不是有效的 JSON')
  }
  return validateProjectManifest(data)
}

export function validateProjectManifest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('project.json 顶层必须是对象')
  if (!requiredText(data.name)) throw new Error('缺少有效的 name')
  if (!CODE_PATTERN.test(String(data.code || ''))) throw new Error('code 需以小写字母开头，仅使用小写字母、数字、点、横线和下划线')
  if (!requiredText(data.version)) throw new Error('缺少有效的 version')
  if (!Array.isArray(data.modules)) throw new Error('modules 必须是数组')

  const modules = data.modules.map((module, index) => normalizeModule(module, index))
  return {
    name: data.name.trim(),
    code: data.code.trim(),
    version: data.version.trim(),
    description: typeof data.description === 'string' ? data.description.trim() : '',
    modules,
    ...(requiredText(data.version_hash) ? { version_hash: data.version_hash.trim() } : {}),
  }
}

function normalizeModule(module, index) {
  if (typeof module === 'string' && module.trim()) return module.trim()
  if (module && typeof module === 'object' && requiredText(module.name)) {
    const code = requiredText(module.code) ? module.code.trim() : `module_${index + 1}`
    if (!CODE_PATTERN.test(code)) throw new Error(`modules[${index}].code 格式不正确`)
    return {
      code,
      name: module.name.trim(),
      description: typeof module.description === 'string' ? module.description.trim() : '',
    }
  }
  throw new Error(`modules[${index}] 必须是名称字符串或包含 name 的对象`)
}

function requiredText(value) {
  return typeof value === 'string' && Boolean(value.trim())
}
