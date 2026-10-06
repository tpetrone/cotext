import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'
import { parseJournal } from './journal'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')
const JOURNAL = '.review/spec.md.json'

test('the dock asks and comments on the whole document, its edits tracked like any other', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))

  // A message with no text starts nothing: there is no passage to explain.
  host.page({ kind: 'openDoc', mode: 'ask', message: '  ' })
  await clock.advance(2000)
  expect(host.spawned).toHaveLength(0)

  host.page({ kind: 'openDoc', mode: 'ask', message: 'Está consistente?' })
  await clock.advance(2000)
  const question = host.view()!.threads[0]!.id
  expect(host.view()!.threads[0]).toMatchObject({ scope: 'doc', quote: '', status: 'thinking' })
  expect(host.spawned[0]!.prompt).toContain("The person's message is about the whole document (no passage selected).")
  expect(host.spawned[0]!.prompt).not.toContain('<passage>')
  expect(host.spawned[0]!.prompt).toContain('<draft>\n# Plan')
  // It has no passage to mark in the text.
  expect(host.view()!.spans).toEqual([])
  await $.turn.complete(DONE(question, 'Sim.'))
  expect(host.view()!.threads[0]).toMatchObject({ status: 'idle', messages: [{}, { from: 'claude', text: 'Sim.' }] })

  host.page({ kind: 'openDoc', mode: 'comment', message: 'Troca REST por gRPC.' })
  await clock.advance(2000)
  const comment = host.view()!.threads[1]!.id
  expect(host.spawned[1]!.prompt).toContain('The person comments (comment: act on it):\nTroca REST por gRPC.')
  await $.turn.complete(DONE(comment, 'Troquei.', [{ old: 'A API será REST.', new: 'A API será gRPC.' }]))
  expect(host.view()!.hunks).toMatchObject([{ removed: 'REST', added: 'gRPC', threads: [comment] }])
  expect(host.view()!.spans.map(one => one.kind)).toEqual(['del', 'ins'])
  expect(host.files.get('spec.md')).toBe(SPEC)

  const round = host.view()!.threads[1]!.messages[1]!.round!
  host.page({ kind: 'undoRound', thread: comment, round })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  host.page({ kind: 'redoRound', thread: comment, round })
  host.page({ kind: 'acceptRound', thread: comment, round })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(SPEC.replace('REST', 'gRPC'))
  expect(host.view()!.threads[1]).toMatchObject({ scope: 'doc', detached: false })
})

test('a thread on the whole document outlives the review and is never detached', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC, 'other.md': '# Other\n' })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'openDoc', mode: 'ask', message: 'Falta algo?' })
  await clock.advance(2000)
  await $.turn.complete(DONE(host.view()!.threads[0]!.id, 'O deploy.'))
  expect(parseJournal(host.files.get(JOURNAL)!, JOURNAL).threads).toMatchObject([{ scope: 'doc' }])

  await $.command.run(OPEN('other.md'))
  host.files.set('spec.md', 'Tudo novo.\n')
  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.threads).toMatchObject([{ scope: 'doc', detached: false, messages: [{}, { text: 'O deploy.' }] }])
  expect(host.view()!.spans).toEqual([])
})
