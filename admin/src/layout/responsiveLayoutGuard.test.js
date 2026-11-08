import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function vueFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.isFile() && entry.name.endsWith('.vue') ? [path] : []
  })
}

describe('responsive layout guard', () => {
  it('reserves enough width for every table operation column', () => {
    const failures = []
    const minimumByButtonCount = [0, 110, 196, 282, 368]

    for (const file of vueFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8')
      const operationColumns = source.matchAll(
        /<el-table-column\b(?=[^>]*label="操作")(?=[^>]*width="(\d+)")[^>]*>([\s\S]*?)<\/el-table-column>/gu,
      )
      for (const match of operationColumns) {
        const width = Number(match[1])
        const buttonCount = [...match[2].matchAll(/<el-button\b/gu)].length
        const minimum = minimumByButtonCount[Math.min(buttonCount, 4)]
        if (width < minimum) failures.push(`${file}: ${buttonCount} buttons use ${width}px; need ${minimum}px`)
      }
    }

    expect(failures).toEqual([])
  })

  it('keeps dialogs inside the viewport', () => {
    const fixedDialogWidths = []
    for (const file of vueFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8')
      if (/<el-dialog\b[^>]*\bwidth="\d+px"/u.test(source)) fixedDialogWidths.push(file)
    }
    expect(fixedDialogWidths).toEqual([])
  })

  it('keeps table actions and pagination from shrinking', () => {
    const css = readFileSync(join(sourceRoot, 'styles', 'base.css'), 'utf8')
    expect(css).toContain('min-width: max-content')
    expect(css).toContain('flex-wrap: nowrap')
    expect(css).toContain('.table-pagination .el-pagination')
    expect(css).toContain('.el-dialog__footer, .el-drawer__footer')
    expect(css).toContain('.el-table .el-table-fixed-column--right')
  })
})
