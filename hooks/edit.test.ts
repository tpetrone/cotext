import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')

test("Editar over the file's text is a change of its own, which Desfazer and Revisar take", async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.segments[1]!.work).toBe('SQLite será o storage.')

  host.page({ kind: 'edit', seg: 1, was: 'SQLite será o storage.', text: 'Postgres será o storage.' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toMatchObject([{ removed: 'SQLite', added: 'Postgres', threads: [] }])
  expect(host.view()!.segments[1]!.work).toBe('Postgres será o storage.')
  expect(host.files.get('spec.md')).toBe(SPEC)

  // The page's Desfazer takes it back, Refazer brings it again.
  host.page({ kind: 'undo' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  host.page({ kind: 'redo' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toHaveLength(1)

  host.page({ kind: 'review' })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(SPEC.replace('SQLite', 'Postgres'))
})

test("Editar over a round's text is a round under it, taken back alone or with it", async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'REST', new: 'gRPC' }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  expect(host.view()!.segments[2]!.work).toBe('A API será gRPC.')

  host.page({ kind: 'edit', seg: 2, was: 'A API será gRPC.', text: 'A API será gRPC-Web.' })
  await clock.advance(2000)
  const edits = () => host.view()!.threads[0]!.messages.filter(one => (one as { kind?: string }).kind === 'edit')
  expect(edits()).toMatchObject([{ from: 'user', parent: round, edits: [{ old: '', new: '-Web', applied: true }] }])
  expect(host.view()!.hunks.every(one => one.threads.includes(id))).toBe(true)
  expect(host.view()!.segments[2]!.work).toBe('A API será gRPC-Web.')
  const child = edits()[0]!.round!

  // The edit alone: the round stays.
  host.page({ kind: 'undoRound', thread: id, round: child })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.view()!.segments[2]!.work).toBe('A API será gRPC.')
  host.page({ kind: 'redoRound', thread: id, round: child })
  await clock.advance(2000)
  expect(host.view()!.segments[2]!.work).toBe('A API será gRPC-Web.')

  // The round takes the edit back with it.
  host.page({ kind: 'undoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.view()!.hunks).toEqual([])
  expect(host.view()!.threads[0]!.messages.filter(one => one.round !== undefined).map(one => one.undone)).toEqual([true, true])
})

test('Editar changes nothing when the text is the same, the block moved on, or the draft is stale', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'edit', seg: 1, was: 'SQLite será o storage.', text: 'SQLite será o storage.' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  expect(host.view()!.canUndo).toBe(false)

  // The page showed a block the draft no longer has.
  host.page({ kind: 'edit', seg: 1, was: 'MySQL será o storage.', text: 'Postgres será o storage.' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  expect(host.toasts.at(-1)).toMatch(/o bloco mudou enquanto você editava/)

  host.page({ kind: 'delete', text: 'A API será REST.', seg: 2 })
  await clock.advance(2000)
  host.files.set('spec.md', SPEC.replace('SQLite', 'MySQL'))
  await clock.advance(2000)
  expect(host.view()!.stale).toBe(true)
  host.page({ kind: 'edit', seg: 1, was: 'SQLite será o storage.', text: 'Postgres será o storage.' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toHaveLength(1)
  expect(host.toasts.at(-1)).toMatch(/changed on disk since the review began/)
})
