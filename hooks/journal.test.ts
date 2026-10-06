import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'
import { parseJournal } from './journal'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', '', 'Deploy fica para depois.', ''].join('\n')
const JOURNAL = '.review/spec.md.json'

test('the threads outlive the review, found again by their text; unsaved proposals do not', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC, 'other.md': '# Other\n' })
  await $.command.run(OPEN('spec.md'))
  // Opening a file with nothing to keep writes no journal.
  expect(host.files.has(JOURNAL)).toBe(false)

  host.page({ kind: 'open', mode: 'ask', text: 'SQLite será o storage.', seg: 1, message: 'Por que SQLite?' })
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  host.page({ kind: 'open', mode: 'ask', text: 'Deploy fica para depois.', seg: 3, message: 'Quando?' })
  await clock.advance(2000)
  const [question, comment] = host.view()!.threads.map(one => one.id)
  await $.turn.complete(DONE(question!, 'É local.'))
  await $.turn.complete(DONE(comment!, 'Troquei para gRPC.', [{ old: 'A API será REST.', new: 'A API será gRPC.' }]))
  expect(host.view()!.hunks).toHaveLength(1)

  // The journal holds the threads by their text, and of the unsaved change only that it was proposed.
  const written = parseJournal(host.files.get(JOURNAL)!, JOURNAL)
  expect(written.accepted).toEqual([])
  expect(written.threads).toMatchObject([
    { id: question, status: 'idle', pending: 0, anchor: { selectedText: 'SQLite será o storage.' } },
    { id: comment, status: 'idle', pending: 1, anchor: { selectedText: 'REST' } },
    { status: 'thinking', pending: 0, anchor: { selectedText: 'Deploy fica para depois.' } },
  ])
  // The draft is not kept; what the reviser proposed is, on its reply.
  expect(written).not.toHaveProperty('hunks')
  expect(written.threads[1]!.messages[1]).toMatchObject({ edits: [{ old: 'A API será REST.', new: 'A API será gRPC.', applied: true }] })
  // Every message keeps the mode it was sent in.
  expect(written.version).toBe(3)
  expect(written.threads.map(one => one.messages.map(m => `${m.from}:${m.mode}`))).toEqual([
    ['user:ask', 'claude:ask'],
    ['user:comment', 'claude:comment'],
    ['user:ask'],
  ])

  // Another file takes the review; meanwhile the file changes on disk.
  await $.command.run(OPEN('other.md'))
  expect(host.view()!.threads).toEqual([])
  host.files.set('spec.md', SPEC.replace('# Plan\n', '# Plan\n\nIntro.\n'))

  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.hunks).toEqual([])
  expect(host.shown()).toContain('A API será REST.')
  expect(host.view()!.threads).toMatchObject([
    { id: question, line: 5, status: 'idle', detached: false, messages: [{ text: 'Por que SQLite?' }, { text: 'É local.' }] },
    {
      id: comment,
      line: 7,
      status: 'idle',
      messages: [{}, { text: 'Troquei para gRPC.' }, { text: '(A alteração proposta não foi salva e foi descartada.)' }],
    },
    { status: 'error', messages: [{}, { text: 'Interrompida: o cotext foi fechado antes da resposta.' }] },
  ])
})

test('Revisar records what it wrote, as text, beside the threads', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const comment = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(comment, 'Troquei.', [{ old: 'A API será REST.', new: 'A API será gRPC.' }]))
  host.page({ kind: 'delete', text: 'Deploy fica para depois.', seg: 3 })
  host.page({ kind: 'review' })
  await clock.advance(2000)

  const written = parseJournal(host.files.get(JOURNAL)!, JOURNAL)
  expect(written.accepted).toHaveLength(1)
  expect(written.accepted[0]!.changes).toEqual([
    { removed: 'REST', added: 'gRPC', threads: [comment] },
    { removed: 'Deploy fica para depois.', added: '', threads: [] },
  ])
  expect(written.threads).toMatchObject([{ id: comment, pending: 0, anchor: { selectedText: 'gRPC' } }])
})

test('Cancelar drops the changes but keeps the threads, telling the ones whose proposals went', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const comment = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(comment, 'Troquei.', [{ old: 'A API será REST.', new: 'A API será gRPC.' }]))

  host.page({ kind: 'cancel' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  expect(host.view()!.threads[0]!.messages.at(-1)!.text).toBe('(A alteração proposta não foi salva e foi descartada.)')
  expect(parseJournal(host.files.get(JOURNAL)!, JOURNAL).threads).toMatchObject([{ id: comment, pending: 0 }])
  expect(host.files.get('spec.md')).toBe(SPEC)
})

test('a journal that does not parse stops the file from opening and is left as it is', async ($, on) => {
  const host = fakeHost(on, { 'spec.md': SPEC, [JOURNAL]: '{ nope' })
  const opened = await $.command.run(OPEN('spec.md'))
  expect(opened.text).toBe(`cotext: ${JOURNAL} is not valid JSON. Fix or move it, then open the file again.`)
  expect(host.files.get(JOURNAL)).toBe('{ nope')
})

test('a thread whose passage is gone comes back detached', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC, 'other.md': '# Other\n' })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'ask', text: 'A API será REST.', seg: 2 })
  await clock.advance(2000)
  await $.turn.complete(DONE(host.view()!.threads[0]!.id, 'Porque sim.'))
  await $.command.run(OPEN('other.md'))
  host.files.set('spec.md', SPEC.replace('A API será REST.\n\n', ''))

  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.threads).toMatchObject([{ detached: true, status: 'idle' }])
  expect(host.view()!.spans).toEqual([])
})

test('a version 2 journal opens with each message in its thread\'s mode, and is written back as version 3', async ($, on) => {
  const clock = mock.clock(on)
  const anchor = { selectedText: 'A API será REST.', start: 24, end: 40, lineStart: 5, lineEnd: 5, contextBefore: '', contextAfter: '' }
  const v2 = {
    version: 2,
    file: 'spec.md',
    threads: [
      {
        id: 'q1',
        type: 'question',
        quote: 'A API será REST.',
        status: 'idle',
        pending: 0,
        anchor,
        messages: [
          { from: 'user', text: 'Por quê?', at: '' },
          { from: 'claude', text: 'Porque sim.', at: '' },
        ],
      },
    ],
    accepted: [],
  }
  const host = fakeHost(on, { 'spec.md': SPEC, [JOURNAL]: JSON.stringify(v2) })
  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.threads).toMatchObject([{ id: 'q1', mode: 'ask', messages: [{ mode: 'ask' }, { mode: 'ask' }] }])

  host.page({ kind: 'reply', thread: 'q1', mode: 'comment', message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const written = parseJournal(host.files.get(JOURNAL)!, JOURNAL)
  expect(written.version).toBe(3)
  expect(written.threads[0]).toMatchObject({ mode: 'ask', messages: [{ mode: 'ask' }, { mode: 'ask' }, { mode: 'comment' }] })
  expect(written.threads[0]).not.toHaveProperty('type')
})
