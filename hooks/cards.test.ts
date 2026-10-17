import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'
import { parseJournal } from './journal'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', '', 'Deploy fica para depois.', ''].join('\n')
const JOURNAL = '.review/spec.md.json'
const ARCHIVE = '.review/archive/spec.md.json'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

/** A comment on `REST` answered in two rounds: REST → gRPC, then a sentence added after it. */
async function twoRounds($: Parameters<Body>[0], on: Parameters<Body>[1]) {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'REST', new: 'gRPC' }]))
  host.page({ kind: 'reply', thread: id, mode: 'comment', message: 'Explica o porquê.' })
  await clock.advance(2000)
  await $.turn.complete(DONE(id, 'Expliquei.', [{ old: 'gRPC.', new: 'gRPC, pelo streaming.' }]))
  const rounds = host.view()!.threads[0]!.messages.filter(one => one.round !== undefined).map(one => one.round!)

  return { clock, host, id, rounds }
}

test('each round can be taken back and made again on its own', async ($, on) => {
  const { clock, host, id, rounds } = await twoRounds($, on)
  expect(rounds).toHaveLength(2)
  expect(host.shown()).toContain('A API será RESTgRPC, pelo streaming.')
  expect(host.view()!.threads[0]!.messages[1]).toMatchObject({ edits: [{ old: 'REST', new: 'gRPC', applied: true }] })

  // The first round goes back alone: the second, on the same sentence, stays.
  host.page({ kind: 'undoRound', thread: id, round: rounds[0] })
  await clock.advance(2000)
  expect(host.view()!.hunks).toMatchObject([{ removed: '', added: ', pelo streaming' }])
  expect(host.view()!.threads[0]!.messages.map(one => one.undone)).toEqual([undefined, true, undefined, undefined])

  host.page({ kind: 'redoRound', thread: id, round: rounds[0] })
  await clock.advance(2000)
  expect(host.shown()).toContain('A API será RESTgRPC, pelo streaming.')
  expect(host.view()!.threads[0]!.messages[1]!.undone).toBe(false)

  // Both back: the draft is as it began.
  host.page({ kind: 'undoRound', thread: id, round: rounds[1] })
  host.page({ kind: 'undoRound', thread: id, round: rounds[0] })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])

  // The page's Desfazer takes the last round's undo back, mark and all.
  host.page({ kind: 'undo' })
  await clock.advance(2000)
  expect(host.shown()).toContain('A API será RESTgRPC.')
  expect(host.view()!.threads[0]!.messages.map(one => one.undone)).toEqual([undefined, false, undefined, true])
})

test('a proposed deletion is found again by the text around it', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'Deploy fica para depois.', seg: 3, message: 'Tira isso.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Tirei.', [{ old: ' para depois', new: '' }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  expect(host.view()!.hunks).toMatchObject([{ removed: ' para depois', added: '' }])

  host.page({ kind: 'undoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  host.page({ kind: 'redoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.view()!.hunks).toMatchObject([{ removed: ' para depois', added: '' }])
})

test('a round whose text changed since cannot be taken back', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'REST', new: 'gRPC' }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  // Another thread rewrites what the round wrote.
  host.page({ kind: 'open', mode: 'comment', text: 'gRPC', seg: 2, message: 'HTTP basta.' })
  await clock.advance(2000)
  const other = host.view()!.threads[1]!.id
  await $.turn.complete(DONE(other, 'Troquei.', [{ old: 'gRPC', new: 'HTTP' }]))
  const before = host.view()!.hunks

  host.page({ kind: 'undoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.toasts.at(-1)).toBe('cotext: o texto mudou desde essa rodada; não dá para desfazê-la.')
  expect(host.view()!.hunks).toEqual(before)
  expect(host.view()!.threads[0]!.messages[1]!.undone).toBeUndefined()
})

test('Arquivar takes the unsaved changes back and keeps the whole thread under .review/archive', async ($, on) => {
  const { clock, host, id } = await twoRounds($, on)
  host.page({ kind: 'archive', thread: id })
  await clock.advance(2000)
  expect(host.view()!.threads).toEqual([])
  expect(host.view()!.hunks).toEqual([])
  expect(host.files.get('spec.md')).toBe(SPEC)

  const archive = JSON.parse(host.files.get(ARCHIVE)!)
  expect(archive).toMatchObject({ version: 1, file: 'spec.md' })
  expect(archive.threads).toHaveLength(1)
  expect(archive.threads[0]).toMatchObject({
    id,
    anchor: { selectedText: 'REST' },
    messages: [
      { from: 'user', mode: 'comment', text: 'Troca por gRPC.' },
      { from: 'claude', text: 'Troquei.', edits: [{ old: 'REST', new: 'gRPC', applied: true }], undone: true },
      { from: 'user', text: 'Explica o porquê.' },
      { from: 'claude', text: 'Expliquei.', edits: [{ old: 'gRPC.', new: 'gRPC, pelo streaming.', applied: true }], undone: true },
    ],
  })
  expect(typeof archive.threads[0].archivedAt).toBe('string')
  expect(parseJournal(host.files.get(JOURNAL)!, JOURNAL).threads).toEqual([])

  // A second one joins the archive.
  host.page({ kind: 'open', mode: 'ask', text: 'Deploy fica para depois.', seg: 3, message: 'Quando?' })
  await clock.advance(2000)
  const ask = host.view()!.threads[0]!.id
  // One still being answered stays.
  host.page({ kind: 'archive', thread: ask })
  await clock.advance(2000)
  expect(host.view()!.threads).toHaveLength(1)
  await $.turn.complete(DONE(ask, 'Depois do MVP.'))
  host.page({ kind: 'archive', thread: ask })
  await clock.advance(2000)
  expect(JSON.parse(host.files.get(ARCHIVE)!).threads.map((one: { id: string }) => one.id)).toEqual([id, ask])
})

test('a saved round is archived as saved', async ($, on) => {
  const { clock, host, id } = await twoRounds($, on)
  host.page({ kind: 'review' })
  await clock.advance(2000)
  host.page({ kind: 'archive', thread: id })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toContain('A API será gRPC, pelo streaming.')
  expect(JSON.parse(host.files.get(ARCHIVE)!).threads[0].messages[1]).toMatchObject({ onDisk: true, undone: false })
})

test('the Lixeira takes the changes back and archives nothing', async ($, on) => {
  const { clock, host, id } = await twoRounds($, on)
  host.page({ kind: 'trash', thread: id })
  await clock.advance(2000)
  expect(host.view()!.threads).toEqual([])
  expect(host.view()!.hunks).toEqual([])
  expect(host.files.has(ARCHIVE)).toBe(false)

  // Desfazer brings the changes back; with no thread, they show on their own.
  host.page({ kind: 'undo' })
  await clock.advance(2000)
  expect(host.view()!.hunks.length).toBeGreaterThan(0)
  expect(host.view()!.hunks.every(one => one.threads.length === 0)).toBe(true)
})

test('a collapsed balloon stays collapsed when the file is opened again', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC, 'other.md': '# Other\n' })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'ask', text: 'A API será REST.', seg: 2, message: 'Por quê?' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Porque sim.'))
  host.page({ kind: 'collapse', thread: id, collapsed: true })
  await clock.advance(2000)
  expect(host.view()!.threads[0]!.collapsed).toBe(true)
  expect(parseJournal(host.files.get(JOURNAL)!, JOURNAL).threads[0]).toMatchObject({ collapsed: true })

  await $.command.run(OPEN('other.md'))
  await $.command.run(OPEN('spec.md'))
  expect(host.view()!.threads[0]!.collapsed).toBe(true)
  host.page({ kind: 'collapse', thread: id, collapsed: false })
  await clock.advance(2000)
  expect(host.view()!.threads[0]!.collapsed).toBe(false)
})

test('rounds whose changes were dropped can be made again', async ($, on) => {
  const { clock, host, id, rounds } = await twoRounds($, on)
  host.page({ kind: 'cancel' })
  await clock.advance(2000)
  expect(host.view()!.threads[0]!.messages.filter(one => one.round).map(one => one.undone)).toEqual([true, true])

  host.page({ kind: 'redoRound', thread: id, round: rounds[0] })
  host.page({ kind: 'redoRound', thread: id, round: rounds[1] })
  await clock.advance(2000)
  expect(host.shown()).toContain('A API será RESTgRPC, pelo streaming.')
})

test('Aceitar writes one round to the file and leaves the rest in the draft', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  host.page({ kind: 'delete', text: 'Deploy fica para depois.', seg: 3 })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'REST', new: 'gRPC' }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  expect(host.view()!.threads[0]!.pending).toEqual([round])

  host.page({ kind: 'acceptRound', thread: id, round })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(SPEC.replace('REST', 'gRPC'))
  expect(host.toasts.at(-1)).toBe('cotext: saved 1 change to spec.md.')
  expect(host.view()!.hunks).toMatchObject([{ removed: 'Deploy fica para depois.\n', added: '' }])
  expect(host.view()!.threads[0]).toMatchObject({ pending: [], changes: 0 })
  expect(host.view()!.threads[0]!.messages[1]).toMatchObject({ onDisk: true })
  expect(parseJournal(host.files.get(JOURNAL)!, JOURNAL).accepted[0]!.changes).toEqual([{ removed: 'REST', added: 'gRPC', threads: [id] }])

  // The accepted round can still be taken back: that is a change to the draft again.
  host.page({ kind: 'undoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.view()!.hunks).toMatchObject([{ removed: 'gRPC', added: 'REST' }, { removed: 'Deploy fica para depois.\n' }])

  // A change of its own is accepted alone.
  const deletion = host.view()!.hunks[1]!.id
  host.page({ kind: 'acceptHunk', hunk: deletion })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(SPEC.replace('REST', 'gRPC').replace('Deploy fica para depois.\n', ''))
  expect(host.view()!.hunks).toMatchObject([{ removed: 'gRPC', added: 'REST' }])
})

const LIST = ['# Plan', '', '- SQLite será o storage.', '- A API será REST.', ''].join('\n')
const REWRITE = 'A API será gRPC, com streaming bidirecional; e terá cache, em memória por cliente.'
// The round's text as the page shows it, after the struck REST.
const WROTE = REWRITE.slice('A API será '.length)

/** A comment on the list's REST item, answered by a round that rewrites it. */
async function listRound($: Parameters<Body>[0], on: Parameters<Body>[1]) {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': LIST })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'A API será REST.', seg: 1, message: 'Detalha.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Detalhei.', [{ old: 'A API será REST.', new: REWRITE }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  const deletions = () => host.view()!.threads[0]!.messages.filter(one => (one as { kind?: string }).kind === 'delete')

  return { clock, host, id, round, deletions }
}

test("an Excluir over a round's text is a round under it, taken back alone or with it", async ($, on) => {
  const { clock, host, id, round, deletions } = await listRound($, on)
  host.page({ kind: 'delete', text: ', com streaming bidirecional', seg: 1 })
  await clock.advance(2000)
  expect(host.shown()).not.toContain('gRPC, com streaming')
  // In the round's thread, not a change of its own.
  expect(deletions()).toMatchObject([{ from: 'user', text: ', com streaming bidirecional', parent: round }])
  expect(host.view()!.hunks.every(one => one.threads.includes(id))).toBe(true)
  const child = deletions()[0]!.round!

  // The Excluir alone: the round stays.
  host.page({ kind: 'undoRound', thread: id, round: child })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.shown()).toContain(WROTE)
  expect(deletions()[0]!.undone).toBe(true)
  host.page({ kind: 'redoRound', thread: id, round: child })
  await clock.advance(2000)
  expect(host.shown()).not.toContain('gRPC, com streaming')

  // The round takes its Excluir back with it, in one step.
  host.page({ kind: 'undoRound', thread: id, round })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.view()!.hunks).toEqual([])
  expect(host.view()!.threads[0]!.messages.filter(one => one.round !== undefined).map(one => one.undone)).toEqual([true, true])

  // Refazer on the Excluir brings the round first.
  host.page({ kind: 'redoRound', thread: id, round: child })
  await clock.advance(2000)
  expect(host.shown()).toContain('gRPC; e terá cache')
  expect(host.view()!.threads[0]!.messages.filter(one => one.round !== undefined).map(one => one.undone)).toEqual([false, false])

  // The page's Desfazer takes that whole Refazer back, then the Desfazer before it.
  host.page({ kind: 'undo' })
  await clock.advance(2000)
  expect(host.view()!.hunks).toEqual([])
  host.page({ kind: 'undo' })
  await clock.advance(2000)
  expect(host.shown()).toContain('gRPC; e terá cache')

  // The reviser, resumed, is told of the Excluir, so it does not write the text back.
  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'Ficou bom?' })
  await clock.advance(2000)
  expect(host.sent.at(-1)!.text).toContain('Since your last answer:\nPerson deleted: «, com streaming bidirecional»')
  expect(host.sent.at(-1)!.text).toContain('The person asks (ask: read-only')
})

test("two Excluir over a round's text are siblings, each taken back alone", async ($, on) => {
  const { clock, host, id, deletions } = await listRound($, on)
  host.page({ kind: 'delete', text: ', com streaming bidirecional', seg: 1 })
  host.page({ kind: 'delete', text: ', em memória por cliente', seg: 1 })
  await clock.advance(2000)
  expect(host.shown()).toContain('gRPC; e terá cache.')
  const [first, second] = deletions().map(one => one.round!)

  host.page({ kind: 'undoRound', thread: id, round: first })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.shown()).toContain('gRPC, com streaming bidirecional; e terá cache.')
  host.page({ kind: 'undoRound', thread: id, round: second })
  await clock.advance(2000)
  expect(host.toasts).toEqual([])
  expect(host.shown()).toContain(WROTE)
  expect(deletions().map(one => one.undone)).toEqual([true, true])
})

test("Aceitar on an Excluir writes it with its round; one over the file's text stays a change of its own", async ($, on) => {
  const { clock, host, id, round, deletions } = await listRound($, on)
  // All of a list item: the line goes, marker and all.
  host.page({ kind: 'delete', text: 'SQLite será o storage.', seg: 1 })
  await clock.advance(2000)
  expect(host.view()!.hunks).toMatchObject([{ removed: '- SQLite será o storage.\n', threads: [] }, { threads: [id] }])
  expect(deletions()).toEqual([])

  host.page({ kind: 'delete', text: ', com streaming bidirecional', seg: 1 })
  await clock.advance(2000)
  host.page({ kind: 'acceptRound', thread: id, round: deletions()[0]!.round! })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(LIST.replace('A API será REST.', 'A API será gRPC; e terá cache, em memória por cliente.'))
  expect(host.view()!.hunks).toMatchObject([{ removed: '- SQLite será o storage.\n' }])
  expect(host.view()!.threads[0]!.messages.filter(one => one.round !== undefined)).toMatchObject([
    { round, onDisk: true },
    { onDisk: true },
  ])
})
