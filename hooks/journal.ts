// What outlives the session, one file per reviewed file under `.review/`: the
// threads, each anchored by its text and the text around it, every message
// with the mode it was sent in (ask or comment), and the changes
// Revisar wrote. Changes not yet saved are a draft and are not kept: the
// threads that proposed them are told so when the review is read back.
// An archived thread leaves the journal for one under `.review/archive/`,
// whole: every round, what Claude answered and what it proposed.

import type { Accepted, Anchor, Hunk, Message, Mode, Thread } from '../types'
import { anchorAt, relocate } from './anchor'
import type { Syntax } from './anchor'
import { lastAsked } from './reviser'

export const JOURNAL_DIR = '.review'
export const ARCHIVE_DIR = `${JOURNAL_DIR}/archive`

/** A thread as the journal keeps it: anchored by text, not by offsets. */
export type SavedThread = Omit<Thread, 'start' | 'end' | 'agentId'> & {
  anchor: Anchor
  /** How many of its proposed changes were in the draft, unsaved, when this was written. */
  pending: number
}

export type Journal = {
  version: 3
  file: string
  threads: SavedThread[]
  accepted: Accepted[]
}

/** Where the journal of `file` lives. */
export function journalPath(file: string): string {
  return `${JOURNAL_DIR}/${file.replace(/^\/+/, '')}.json`
}

/** A thread as of now, anchored in `base`, counting its hunks over it. */
function saveThread(base: string, hunks: readonly Hunk[], one: Thread): SavedThread {
  const { start, end, agentId: _, ...rest } = one

  return {
    ...rest,
    anchor: anchorAt(base, { start, end }),
    pending: hunks.filter(hunk => hunk.threads.includes(one.id)).length,
  }
}

/** The journal of `file` as of now: the threads anchored in `base`, the hunks over it. */
export function serializeJournal(
  file: string,
  base: string,
  hunks: readonly Hunk[],
  threads: readonly Thread[],
  accepted: readonly Accepted[],
): string {
  const journal: Journal = {
    version: 3,
    file,
    threads: threads.map(one => saveThread(base, hunks, one)),
    accepted: [...accepted],
  }

  return JSON.stringify(journal, null, 2) + '\n'
}

/** A thread put away, with when. */
export type ArchivedThread = SavedThread & { archivedAt: string }

export type Archive = { version: 1; file: string; threads: ArchivedThread[] }

/** Where the archived threads of `file` live. */
export function archivePath(file: string): string {
  return `${ARCHIVE_DIR}/${file.replace(/^\/+/, '')}.json`
}

/**
 * The archive of `file` with `thread` added, from what it held (`existing`,
 * undefined when there is none). Throws on one it cannot read rather than
 * start it over, so no archived thread is lost.
 */
export function appendArchive(
  existing: string | undefined,
  path: string,
  file: string,
  base: string,
  thread: Thread,
  at: string,
): string {
  let archive: Archive = { version: 1, file, threads: [] }
  if (existing !== undefined) {
    try {
      archive = JSON.parse(existing) as Archive
    } catch {
      throw new Error(`${path} is not valid JSON. Fix or move it, then archive again.`)
    }
    if (archive?.version !== 1 || !Array.isArray(archive.threads)) throw new Error(`${path} is not a version 1 review archive.`)
  }
  const saved: ArchivedThread = { ...saveThread(base, [], thread), archivedAt: at }

  return JSON.stringify({ ...archive, threads: [...archive.threads, saved] }, null, 2) + '\n'
}

/**
 * The thread once the unsaved changes are dropped from the draft: each round
 * whose edits were applied is taken back unless they are in the file on disk.
 */
export function dropUnsaved<T extends Pick<Thread, 'messages'>>(thread: T): T {
  if (!thread.messages.some(one => hasApplied(one) && one.undone !== !one.onDisk)) return thread

  return { ...thread, messages: thread.messages.map(one => (hasApplied(one) ? { ...one, undone: !one.onDisk } : one)) }
}

/** A round whose edits reached the draft: one Desfazer and Refazer act on. */
export function hasApplied(message: Message): boolean {
  return message.round !== undefined && (message.edits ?? []).some(one => one.applied)
}

/**
 * A journal's text. Throws on one it cannot read rather than answer empty,
 * so a later write never overwrites it.
 */
export function parseJournal(text: string, path: string): Journal {
  let parsed: { version?: unknown; threads?: unknown; accepted?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or move it, then open the file again.`)
  }
  if ((parsed.version !== 2 && parsed.version !== 3) || !Array.isArray(parsed.threads) || !Array.isArray(parsed.accepted)) {
    throw new Error(`${path} is not a version 2 or 3 review journal.`)
  }

  return parsed.version === 2 ? fromV2(parsed as unknown as JournalV2) : (parsed as Journal)
}

type JournalV2 = Omit<Journal, 'version' | 'threads'> & {
  version: 2
  threads: (Omit<SavedThread, 'mode' | 'messages'> & {
    type: 'question' | 'comment'
    messages: Omit<Thread['messages'][number], 'mode'>[]
  })[]
}

/** A version 2 journal, where the thread had a type and its messages none: each message takes the thread's. */
function fromV2(journal: JournalV2): Journal {
  return {
    ...journal,
    version: 3,
    threads: journal.threads.map(({ type, messages, ...rest }) => {
      const mode: Mode = type === 'question' ? 'ask' : 'comment'

      return { ...rest, mode, messages: messages.map(one => ({ ...one, mode })) }
    }),
  }
}

/**
 * The journal's threads on `source`, the file as it is now: each found again
 * by its text and context, or detached; one about the whole document stays at
 * 0..0. A thread whose reviser was running is marked interrupted; one whose
 * proposals were never saved is told they are gone, and their rounds are taken
 * back so Refazer can bring them again.
 */
export function restoreThreads(journal: Journal, source: string, syntax: Syntax, at: string): Thread[] {
  return journal.threads.map(saved => {
    const { anchor, pending, detached, ...rest } = saved
    const found = detached === true || rest.scope === 'doc' ? null : relocate(source, anchor, syntax)
    let thread: Thread =
      rest.scope === 'doc'
        ? { ...rest, start: 0, end: 0 }
        : found === null
          ? { ...rest, start: Math.min(anchor.start, source.length), end: Math.min(anchor.end, source.length), detached: true }
          : { ...rest, start: found.start, end: found.end }
    if (thread.status === 'thinking') {
      thread = { ...thread, status: 'error', messages: [...thread.messages, { from: 'claude', text: INTERRUPTED, at, mode: lastAsked(thread) }] }
    }
    // The draft starts empty: each round is as the file on disk has it.
    thread = dropUnsaved(thread)
    if (pending > 0) {
      thread = { ...thread, messages: [...thread.messages, { from: 'claude', text: discarded(pending), at, mode: lastAsked(thread) }] }
    }

    return thread
  })
}

const INTERRUPTED = 'Interrompida: o cotext foi fechado antes da resposta.'

/** The note on a thread whose proposed changes were dropped without being saved. */
export function discarded(count: number): string {
  return count === 1
    ? '(A alteração proposta não foi salva e foi descartada.)'
    : `(As ${count} alterações propostas não foram salvas e foram descartadas.)`
}

/** What Revisar wrote, as text: offsets lose their meaning once the file changes again. */
export function acceptedOf(base: string, hunks: readonly Hunk[], at: string): Accepted {
  return {
    at,
    changes: hunks.map(one => ({ removed: base.slice(one.start, one.end), added: one.text, threads: [...one.threads] })),
  }
}
