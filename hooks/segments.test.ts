import { expect, test } from 'claude-code/testing'

import { chunkLines, segment, segmentAt, syntaxOf } from './segments'

test('splits on blank lines but keeps a fence whole', () => {
  const source = ['# Title', '', 'Para one.', '', '```ts', 'const a = 1', '', 'const b = 2', '```', '', 'End.'].join('\n')
  const parts = segment(source)
  expect(parts.map(one => one.text)).toEqual([
    '# Title',
    'Para one.',
    '```ts\nconst a = 1\n\nconst b = 2\n```',
    'End.',
  ])
  for (const one of parts) expect(source.slice(one.start, one.end)).toBe(one.text)
  expect(segmentAt(parts, source.indexOf('const b'))).toBe(2)
})

test('cuts code into numbered blocks of whole lines', () => {
  const source = Array.from({ length: 95 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const parts = chunkLines(source)
  expect(parts.map(one => one.line)).toEqual([1, 41, 81])
  expect(parts[2]!.text.split('\n')).toHaveLength(15)
  for (const one of parts) expect(source.slice(one.start, one.end)).toBe(one.text)
})

test('tells Markdown from code by extension', () => {
  expect(syntaxOf('docs/plan.md')).toBe('markdown')
  expect(syntaxOf('src/sync.ts')).toBe('code')
})
