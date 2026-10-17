// How a thread's rounds hang together. An Excluir over the text a round of
// Claude's wrote is a round of its own under it: the child only holds while
// its parent is applied, so taking the parent back takes the children back
// first, and bringing a child again brings its parent first. Siblings stand
// alone.

import type { Message, Thread } from '../types'
import { hasApplied } from './journal'

/**
 * The round an Excluir over hunks made by `rounds` goes under: of Claude's
 * rounds among them still applied, the newest. None when it deleted only text
 * of the file or of rounds taken back.
 */
export function parentOf(threads: readonly Thread[], rounds: readonly string[]): { thread: string; round: string } | undefined {
  let found: { thread: string; round: string; at: string } | undefined
  for (const thread of threads) {
    for (const one of thread.messages) {
      if (one.from !== 'claude' || !hasApplied(one) || one.undone === true || !rounds.includes(one.round!)) continue
      if (found === undefined || one.at >= found.at) found = { thread: thread.id, round: one.round!, at: one.at }
    }
  }

  return found === undefined ? undefined : { thread: found.thread, round: found.round }
}

/** The children of `round` still applied, oldest first. */
export function childrenOf(messages: readonly Message[], round: string): Message[] {
  return messages.filter(one => one.parent === round && one.round !== undefined && one.undone !== true)
}

/** What Desfazer on `round` takes back, in order: its applied children, newest first and theirs before them, then itself. */
export function undoChain(messages: readonly Message[], round: string): string[] {
  return [
    ...childrenOf(messages, round)
      .reverse()
      .flatMap(one => undoChain(messages, one.round!)),
    round,
  ]
}

/** `round` and the rounds above it, nearest first: what an Aceitar on it must write with it. */
export function lineage(messages: readonly Message[], round: string): string[] {
  const of = messages.find(one => one.round === round)?.parent

  return of === undefined || !messages.some(one => one.round === of) ? [round] : [round, ...lineage(messages, of)]
}

/** What Refazer on `round` brings again, in order: its parents taken back, oldest first, then itself. */
export function redoChain(messages: readonly Message[], round: string): string[] {
  const of = messages.find(one => one.round === round)?.parent
  const parent = of === undefined ? undefined : messages.find(one => one.round === of)
  if (parent === undefined || parent.undone !== true) return [round]

  return [...redoChain(messages, parent.round!), round]
}
