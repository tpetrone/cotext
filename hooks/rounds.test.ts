import { expect, test } from 'claude-code/testing'

import type { Message } from '../types'
import { lineage, parentOf, redoChain, undoChain } from './rounds'

const EDIT = [{ old: 'a', new: 'b', applied: true }]

/** Claude's round `r`, and Excluir rounds `d1`, `d2` under it. */
function messages(over: Partial<Record<string, Partial<Message>>> = {}): Message[] {
  const one = (round: string, rest: Partial<Message>): Message => ({
    from: 'user',
    text: round,
    at: `2026-10-17T00:00:0${round.at(-1)}Z`,
    mode: 'comment',
    round,
    edits: EDIT,
    ...rest,
    ...over[round],
  })

  return [
    { from: 'user', text: 'Troca.', at: '2026-10-17T00:00:00Z', mode: 'comment' },
    one('r1', { from: 'claude' }),
    one('d2', { kind: 'delete', parent: 'r1' }),
    one('d3', { kind: 'delete', parent: 'r1' }),
  ]
}

test('Desfazer on a round takes its applied Excluir rounds back first, newest first', () => {
  expect(undoChain(messages(), 'r1')).toEqual(['d3', 'd2', 'r1'])
  expect(undoChain(messages({ d3: { undone: true } }), 'r1')).toEqual(['d2', 'r1'])
  // A sibling goes back alone.
  expect(undoChain(messages(), 'd2')).toEqual(['d2'])
})

test('Refazer on an Excluir round brings its parent first when it was taken back', () => {
  expect(redoChain(messages({ d2: { undone: true } }), 'd2')).toEqual(['d2'])
  expect(redoChain(messages({ r1: { undone: true }, d2: { undone: true } }), 'd2')).toEqual(['r1', 'd2'])
  expect(redoChain(messages({ r1: { undone: true } }), 'r1')).toEqual(['r1'])
})

test('Aceitar on an Excluir round writes its parent with it', () => {
  expect(lineage(messages(), 'd2')).toEqual(['d2', 'r1'])
  expect(lineage(messages(), 'r1')).toEqual(['r1'])
})

test("an Excluir goes under the newest of Claude's applied rounds it touched", () => {
  const thread = (id: string, list: Message[]) => ({ id, mode: 'comment' as const, start: 0, end: 0, quote: '', status: 'idle' as const, messages: list })
  const older = messages().slice(0, 2)
  const newer = messages().slice(0, 2).map(one => (one.round === 'r1' ? { ...one, round: 'r9', at: '2026-10-17T00:00:09Z' } : one))
  const threads = [thread('t1', older), thread('t2', newer)]
  expect(parentOf(threads, ['r1', 'r9'])).toEqual({ thread: 't2', round: 'r9' })
  // Taken back, or the person's own Excluir: not a parent.
  expect(parentOf([thread('t1', messages({ r1: { undone: true } }))], ['r1', 'd2'])).toBeUndefined()
  expect(parentOf(threads, [])).toBeUndefined()
})
