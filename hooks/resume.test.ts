import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

/** A question on `REST`, answered by the reviser the thread spawned. */
async function answered($: Parameters<Body>[0], on: Parameters<Body>[1]) {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'ask', text: 'REST', seg: 2, message: 'Por que REST?' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'É simples.'))

  return { clock, host, id }
}

test("a thread's next message resumes its reviser instead of spawning another", async ($, on) => {
  const { clock, host, id } = await answered($, on)
  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'E gRPC?' })
  await clock.advance(2000)
  expect(host.spawned).toHaveLength(1)
  expect(host.sent).toHaveLength(1)
  expect(host.sent[0]!.to).toBe(`agent-${id}`)
  // Nothing changed since it read the draft: it is not sent again.
  expect(host.sent[0]!.text).toContain('The draft has not changed since you last read it.')
  expect(host.sent[0]!.text).not.toContain('<draft>')
  expect(host.sent[0]!.text).toContain('<passage>\nREST\n</passage>')
  expect(host.sent[0]!.text.endsWith('The person asks (ask: read-only, propose no edits):\nE gRPC?\n\nThread id: ' + id)).toBe(true)
  expect(host.view()!.threads[0]!.status).toBe('thinking')

  await $.turn.complete(DONE(id, 'Também serve.'))
  expect(host.view()!.threads[0]!.messages.map(one => one.text)).toEqual(['Por que REST?', 'É simples.', 'E gRPC?', 'Também serve.'])
})

test('a resumed reviser is sent the draft when it changed, and its rounds taken back', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'comment', text: 'REST', seg: 2, message: 'Troca por gRPC.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'REST', new: 'gRPC' }]))
  const round = host.view()!.threads[0]!.messages[1]!.round!
  host.page({ kind: 'undoRound', thread: id, round })
  host.page({ kind: 'reply', thread: id, mode: 'comment', message: 'Melhor GraphQL.' })
  await clock.advance(2000)
  expect(host.spawned).toHaveLength(1)
  const text = host.sent[0]!.text
  expect(text).toContain('<draft>\n# Plan\n\nSQLite será o storage.\n\nA API será REST.\n\n</draft>')
  expect(text).toContain('These answers of yours are taken back now; their edits are not in the draft:\n- «Troquei.»')
})

test('a reviser that can no longer be reached is replaced by a new one with the whole thread', async ($, on) => {
  const { clock, host, id } = await answered($, on)
  host.delivers = false
  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'E gRPC?' })
  await clock.advance(2000)
  expect(host.spawned).toHaveLength(2)
  expect(host.spawned[1]!.prompt).toContain('<draft>')
  expect(host.spawned[1]!.prompt).toContain('Person (ask): Por que REST?\nYou: É simples.')

  // The new reviser is the one the thread resumes from then on.
  host.delivers = true
  await $.turn.complete({ ...DONE(id, 'Também serve.'), agentId: 'agent-new' })
  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'E SOAP?' })
  await clock.advance(2000)
  expect(host.sent.map(one => one.to)).toEqual(['agent-new'])
})

test('after a reviser stops short, the next message spawns a new one', async ($, on) => {
  const { clock, host, id } = await answered($, on)
  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'E gRPC?' })
  await clock.advance(2000)
  await $.turn.complete({ ...DONE(id, ''), isAborted: true })
  expect(host.view()!.threads[0]!.status).toBe('error')

  host.page({ kind: 'reply', thread: id, mode: 'ask', message: 'De novo: e gRPC?' })
  await clock.advance(2000)
  expect(host.sent).toHaveLength(1)
  expect(host.spawned).toHaveLength(2)
})
