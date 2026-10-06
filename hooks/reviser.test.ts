import { expect, test } from 'claude-code/testing'

import { buildAsk, findEdit, parseProposal } from './reviser'

test('the reply and edits come from the last json block', () => {
  const answer = [
    'Troquei para Postgres.',
    '',
    '```json',
    '{ "thread": "t1", "reply": "Troquei para Postgres.", "edits": [{ "old": "SQLite", "new": "Postgres" }, { "old": "", "new": "x" }] }',
    '```',
  ].join('\n')
  expect(parseProposal(answer)).toEqual({
    thread: 't1',
    reply: 'Troquei para Postgres.',
    edits: [{ old: 'SQLite', new: 'Postgres' }],
  })
})

test('an answer with no block is all reply, and a block with no reply takes the prose', () => {
  expect(parseProposal('Depende do volume.')).toEqual({ reply: 'Depende do volume.', edits: [] })
  expect(parseProposal('Explicação.\n```json\n{ "edits": [] }\n```')).toEqual({ reply: 'Explicação.', edits: [] })
})

test('of several matches, the edit nearest the passage wins', () => {
  const draft = 'banco A. banco B. banco C.'
  expect(findEdit(draft, 'banco', 18)).toEqual({ start: 18, end: 23 })
  expect(findEdit(draft, ' banco C. ', 0)).toEqual({ start: 18, end: 26 })
  expect(findEdit(draft, 'tabela', 0)).toBeUndefined()
})

test('the ask carries the draft, the passage and the thread so far', () => {
  const ask = buildAsk({
    id: 't1',
    file: 'spec.md',
    draft: '# Plan\n\nSQLite.\n',
    passage: { start: 8, end: 15, text: 'SQLite.', lineStart: 3, lineEnd: 3 },
    thread: {
      messages: [
        { from: 'user', text: 'Por quê?', at: '', mode: 'ask' },
        { from: 'claude', text: 'É local.', at: '', mode: 'ask' },
        { from: 'user', text: 'E concorrência?', at: '', mode: 'ask' },
      ],
    },
  })
  expect(ask).toContain('<draft>\n# Plan\n\nSQLite.\n\n</draft>')
  expect(ask).toContain('The selected passage (L3):\n<passage>\nSQLite.\n</passage>')
  expect(ask).toContain('Person (ask): Por quê?\nYou: É local.')
  expect(ask.endsWith('The person asks (ask: read-only, propose no edits):\nE concorrência?\n\nThread id: t1')).toBe(true)
})
