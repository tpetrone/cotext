import { expect, test } from 'claude-code/testing'

import type { Annotation } from '../types'
import { buildReviewPrompt, promptOrder } from './review-prompt'

const at = (selectedText: string, line: number) => ({
  selectedText,
  start: 0,
  end: selectedText.length,
  lineStart: line,
  lineEnd: line,
  contextBefore: '',
  contextAfter: '',
})

const one = (type: Annotation['type'], text: string, line: number, comment?: string): Annotation => ({
  id: text,
  file: 'architecture.md',
  type,
  anchor: at(text, line),
  ...(comment === undefined ? {} : { comment }),
  status: 'open',
  createdAt: '2026-10-02T00:00:00.000Z',
})

test('numbers annotations, quotes their text and keeps the guidelines', () => {
  const prompt = buildReviewPrompt(
    [
      one('investigate', 'SQLite será utilizado como storage principal', 23, 'Investigue alternativas.'),
      one('reject', 'Graphiti será obrigatório no MVP', 48),
      one('highlight', 'Retry mechanism', 92),
    ],
    'review',
  )
  expect(prompt.startsWith('COTEXT REVIEW: the user reviewed `architecture.md` and left 3 annotations.')).toBe(true)
  expect(prompt).toContain('ANNOTATION 1: investigate (L23)\n> SQLite será utilizado como storage principal')
  expect(prompt).toContain('Note: Investigue alternativas.')
  expect(prompt).toContain('ANNOTATION 2: reject (L48)')
  expect(prompt).toContain('Meaning: The user disagrees with this. Reconsider it.')
  expect(prompt).toContain('ANNOTATION 3: highlight (L92)')
  expect(prompt).toContain('Do not change accepted decisions unless another annotation requires it.')
})

test('states the mode, how to report back, and what was handed back before', () => {
  const back: Annotation = {
    ...one('question', 'A API será REST', 5),
    status: 'needs_human',
    resolution: { summary: 'Depende do cliente.', at: '2026-10-02T00:00:00.000Z' },
  }
  const apply = buildReviewPrompt([back], 'apply')
  expect(apply).toContain('Mode: APPLY')
  expect(apply).toContain('Earlier you handed this back: Depende do cliente.')
  expect(apply).toContain('`mcp__cotext__resolve_annotations`')
  expect(buildReviewPrompt([back], 'review')).toContain('file edits are blocked')
})

test('numbers annotations file by file, in the order a send records', () => {
  const a = { ...one('highlight', 'one', 1), file: 'b.md' }
  const b = { ...one('highlight', 'two', 2), file: 'a.md' }
  const c = { ...one('highlight', 'three', 3), file: 'b.md' }
  expect(promptOrder([a, b, c]).map(x => x.anchor.selectedText)).toEqual(['one', 'three', 'two'])
  expect(buildReviewPrompt([a, b, c], 'review')).toMatch(/ANNOTATION 2: highlight \(L3\)\n> three/)
})
