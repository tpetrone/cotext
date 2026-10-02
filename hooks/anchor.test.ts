import { describe, expect, test } from 'claude-code/testing'

import { locate, relocate } from './anchor'

const SPEC = [
  '# Storage',
  '',
  'Para persistência local, **SQLite** será utilizado como storage principal',
  'durante a primeira versão do produto.',
  '',
  '- A API será REST.',
  '- A API será REST.',
].join('\n')

describe('locate', () => {
  test('finds rendered text across bold markers and a line break', () => {
    const found = locate(SPEC, 'SQLite será utilizado como storage principal durante a primeira')
    if (found.kind !== 'found') throw new Error(found.kind)
    expect(found.anchor.selectedText).toBe(
      'SQLite** será utilizado como storage principal\ndurante a primeira',
    )
    expect(found.anchor.lineStart).toBe(3)
    expect(found.anchor.lineEnd).toBe(4)
    expect(found.anchor.contextBefore.endsWith('local, **')).toBe(true)
  })

  test('ignores a heading marker the pane does not draw', () => {
    const found = locate(SPEC, 'Storage')
    expect(found.kind).toBe('found')
  })

  test('reports text that is not there', () => {
    expect(locate(SPEC, 'Postgres').kind).toBe('missing')
  })

  test('reports duplicate text as ambiguous', () => {
    expect(locate(SPEC, 'A API será REST.')).toEqual({ kind: 'ambiguous', count: 2 })
  })

  test('tells duplicates apart by stored context', () => {
    const found = locate(SPEC, 'A API será REST.', { hint: { contextBefore: 'REST.\n- ' } })
    if (found.kind !== 'found') throw new Error(found.kind)
    expect(found.anchor.lineStart).toBe(7)
  })
})

describe('locate in code', () => {
  const CODE = 'const total = a * b_c\n// see `notes`\n'

  test('keeps the characters Markdown would drop', () => {
    const found = locate(CODE, 'a * b_c', { syntax: 'code' })
    if (found.kind !== 'found') throw new Error(found.kind)
    expect(found.anchor.selectedText).toBe('a * b_c')
  })

  test('finds a selection that took the gutter numbers with it', () => {
    const found = locate(CODE, ' 1 const total = a * b_c\n 2 // see `notes`', { syntax: 'code' })
    if (found.kind !== 'found') throw new Error(found.kind)
    expect(found.anchor.lineEnd).toBe(2)
  })
})

function located(text: string) {
  const found = locate(SPEC, text)
  if (found.kind !== 'found') throw new Error(found.kind)

  return found.anchor
}

describe('relocate', () => {
  test('follows text that moved after an edit', () => {
    const found = locate(SPEC, 'primeira versão')
    if (found.kind !== 'found') throw new Error(found.kind)
    const edited = `Intro paragraph.\n\n${SPEC}`
    const moved = relocate(edited, found.anchor)
    expect(moved?.lineStart).toBe(found.anchor.lineStart + 2)
  })

  test('keeps the symbol and renumbers lines when the range still holds', () => {
    const anchor = { ...located('primeira versão'), symbol: 'Spec' }
    const moved = relocate(`${SPEC}\nmore`, anchor)
    expect(moved).toBe(anchor)
  })

  test('gives up on text that was removed', () => {
    const found = locate(SPEC, 'primeira versão')
    if (found.kind !== 'found') throw new Error(found.kind)
    expect(relocate('# Storage\n', found.anchor)).toBe(null)
  })
})
