import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, PANE, fakeHost } from './fake-host'

const SPEC = [
  '# Architecture',
  '',
  'Para persistência local, **SQLite** será utilizado como storage principal.',
  '',
  'A API será REST.',
  '',
  'O storage remoto fica para depois.',
  '',
].join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`questions and comments go to a reviser, its edits show as revisions, and only Revisar saves on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'spec.md': SPEC })

    const opened = await $.command.run(OPEN('@spec.md'))
    expect(opened.text).toBe('Reviewing spec.md.')
    expect(host.servers[0]![1]).toMatch(/server\/server\.mjs$/)
    expect(host.opened[0]![1]).toMatch(/^http:\/\/localhost:4711\/\?t=\w+$/)
    expect(host.view()!.segments.map(one => one.line)).toEqual([1, 3, 5, 7])

    // Excluir strikes the passage through at once, with no reviser.
    host.page({ kind: 'delete', text: 'O storage remoto fica para depois.', seg: 3 })
    await clock.advance(2000)
    expect(host.view()!.hunks).toMatchObject([{ removed: 'O storage remoto fica para depois.', added: '', threads: [] }])
    expect(host.view()!.spans).toMatchObject([{ kind: 'del' }])
    expect(host.spawned).toHaveLength(0)

    // Questionar: what the page drew is rendered Markdown, so the selection lacks the `**`.
    host.page({ kind: 'open', mode: 'ask', text: 'SQLite será utilizado', seg: 1, message: 'Por que SQLite?' })
    await clock.advance(2000)
    expect(host.spawned[0]!.subagentType).toBe('cotext:reviser')
    expect(host.spawned[0]!.prompt).toContain('<passage>\nSQLite** será utilizado\n</passage>')
    expect(host.spawned[0]!.prompt).toContain('The person asks (ask: read-only, propose no edits):\nPor que SQLite?')
    // The reviser reads the draft, not the disk: the deletion is already gone from it.
    expect(host.spawned[0]!.prompt).not.toContain('O storage remoto')
    expect(host.view()!.threads).toMatchObject([{ mode: 'ask', status: 'thinking', quote: 'SQLite será utilizado' }])

    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    expect(await ui.find({ text: /Claude is on 1/ })).toBeDefined()

    const question = host.view()!.threads[0]!.id
    expect(host.spawned[0]!.prompt).toContain(`Thread id: ${question}`)
    await $.turn.complete(DONE(question, 'É local e não precisa de servidor.'))
    expect(host.view()!.threads[0]).toMatchObject({
      status: 'idle',
      changes: 0,
      messages: [
        { from: 'user', text: 'Por que SQLite?' },
        { from: 'claude', text: 'É local e não precisa de servidor.' },
      ],
    })

    // Comentar: the reviser's edit lands in the text as a revision, the file untouched.
    host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
    await clock.advance(2000)
    const comment = host.view()!.threads[1]!.id
    await $.turn.complete(DONE(comment, 'Troquei para gRPC.', [{ old: 'A API será REST.', new: 'A API será gRPC.' }]))
    expect(host.view()!.hunks).toMatchObject([
      { removed: 'REST', added: 'gRPC', threads: [comment] },
      { removed: 'O storage remoto fica para depois.' },
    ])
    expect(host.shown()).toContain('A API será RESTgRPC.')
    expect(host.view()!.threads[1]).toMatchObject({ changes: 1, messages: [{}, { text: 'Troquei para gRPC.' }] })
    expect(host.files.get('spec.md')).toBe(SPEC)

    // Every step comes back: Desfazer, Refazer, and the balloon's own undo.
    await ui.press({ key: 'undo' })
    expect(host.view()!.hunks).toHaveLength(1)
    expect(host.view()!.canRedo).toBe(true)
    host.page({ kind: 'redo' })
    await clock.advance(2000)
    expect(host.view()!.hunks).toHaveLength(2)
    const round = host.view()!.threads[1]!.messages[1]!.round!
    host.page({ kind: 'undoRound', thread: comment, round })
    await clock.advance(2000)
    expect(host.view()!.hunks.map(one => one.added)).toEqual([''])
    expect(host.view()!.threads[1]!.messages[1]!.undone).toBe(true)
    host.page({ kind: 'undo' })
    await clock.advance(2000)
    expect(host.view()!.hunks).toHaveLength(2)
    expect(host.view()!.threads[1]!.messages[1]!.undone).toBe(false)
    expect(host.files.get('spec.md')).toBe(SPEC)

    // Revisar writes the draft, tells the conversation, and keeps the balloons.
    await ui.press({ key: 'review' })
    expect(host.files.get('spec.md')).toBe(SPEC.replace('REST', 'gRPC').replace('O storage remoto fica para depois.', ''))
    expect(host.toasts.at(-1)).toBe('cotext: saved 2 changes to spec.md.')
    expect(host.view()).toMatchObject({ hunks: [], canUndo: false })
    expect(host.view()!.threads).toHaveLength(2)
    expect(host.view()!.spans.map(one => one.kind)).toEqual(['thread', 'thread'])
    await ui.unmount()
  })

  test(`a reply goes back to a reviser with the thread so far on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    host.page({ kind: 'open', mode: 'ask', text: 'A API será REST.', seg: 2 })
    await clock.advance(2000)
    // A question needs no words; a comment does.
    expect(host.spawned[0]!.prompt).toContain('The person asks (ask: read-only, propose no edits):\nExplain this passage.')
    host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: '  ' })
    await clock.advance(2000)
    expect(host.toasts).toContain('A comment needs text.')

    const id = host.view()!.threads[0]!.id
    await $.turn.complete(DONE(id, 'REST porque o cliente é web.'))
    // One answer per ask: a second one is ignored.
    await $.turn.complete(DONE(id, 'Outra.', [{ old: 'REST', new: 'SOAP' }]))
    expect(host.view()!.hunks).toEqual([])
    expect(host.view()!.threads[0]!.messages).toHaveLength(2)

    // Each message has its own mode: an ask is read-only, whatever the reviser proposes.
    host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'E se for mobile?' })
    await clock.advance(2000)
    expect(host.spawned[1]!.prompt).toContain('You: REST porque o cliente é web.')
    expect(host.spawned[1]!.prompt).toContain('The person asks (ask: read-only, propose no edits):\nE se for mobile?')
    expect(host.view()!.threads[0]!.status).toBe('thinking')
    await $.turn.complete(DONE(id, 'Para mobile, gRPC.', [{ old: 'REST', new: 'gRPC' }]))
    expect(host.view()!.hunks).toEqual([])
    expect(host.view()!.threads[0]!.messages.at(-1)).toMatchObject({ from: 'claude', mode: 'ask' })
    expect(host.view()!.threads[0]!.messages.at(-1)!.text).toMatch(/só leitura: as alterações propostas foram ignoradas/)

    // A comment needs words, on a reply too.
    host.page({ kind: 'reply', thread: id, mode: 'comment', message: '  ' })
    await clock.advance(2000)
    expect(host.spawned).toHaveLength(2)

    // A comment on a thread opened as an ask acts on the text.
    host.page({ kind: 'reply', thread: id, mode: 'comment', message: 'Troca por gRPC.' })
    await clock.advance(2000)
    expect(host.spawned[2]!.prompt).toContain('Person (ask): E se for mobile?')
    expect(host.spawned[2]!.prompt).toContain('The person comments (comment: act on it):\nTroca por gRPC.')

    // An edit whose text is not in the draft is reported back, the rest applied.
    await $.turn.complete(
      DONE(id, 'Troquei para gRPC.', [
        { old: 'REST', new: 'gRPC' },
        { old: 'GraphQL', new: 'x' },
      ]),
    )
    expect(host.view()!.hunks).toMatchObject([{ removed: 'REST', added: 'gRPC' }])
    expect(host.view()!.threads[0]!.messages.at(-1)!.text).toMatch(/1 alteração proposta não foi aplicada/)
    expect(host.view()!.threads[0]!.messages.map(one => `${one.from}:${one.mode}`)).toEqual([
      'user:ask',
      'claude:ask',
      'user:ask',
      'claude:ask',
      'user:comment',
      'claude:comment',
    ])

    // The Lixeira drops the thread and takes its changes out of the draft.
    host.page({ kind: 'trash', thread: id })
    await clock.advance(2000)
    expect(host.view()!.threads).toEqual([])
    expect(host.view()!.hunks).toEqual([])
  })

  test(`Cancelar drops the changes, keeps the threads and leaves the file on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    host.page({ kind: 'delete', text: 'remoto', seg: 3 })
    host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'gRPC?' })
    await clock.advance(2000)

    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    await ui.press({ key: 'cancel' })
    expect(host.view()).toMatchObject({ hunks: [], threads: [{ quote: 'REST', status: 'thinking' }] })
    expect(host.toasts.at(-1)).toBe('cotext: discarded 1 change.')
    // A reviser for no thread changes nothing.
    await $.turn.complete(DONE('gone', 'ok', [{ old: 'REST', new: 'gRPC' }]))
    expect(host.view()!.hunks).toEqual([])
    expect(host.files.get('spec.md')).toBe(SPEC)
    await ui.unmount()
  })
}
