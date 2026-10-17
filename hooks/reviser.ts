// The subagent a thread's first message spawns and its next ones resume: what
// it is told, and how its answer becomes a reply in the balloon and edits in the draft.

import type { Mode, Thread } from '../types'

export const REVISER = 'reviser'

/** The type `$.agent.spawn` names: a plugin's agent is `<plugin>:<name>`. */
export const REVISER_TYPE = `cotext:${REVISER}`

/** The reviser reads, never writes: the draft lives in the mod until Revisar. */
export const REVISER_TOOLS = ['Read', 'Grep', 'Glob'] as const

export const REVISER_PROMPT = [
  'You help a person review a document in cotext. They selected a passage of their draft, or wrote about',
  'the document as a whole, and asked or commented. You answer, and on a comment you may propose edits',
  'to the draft.',
  '',
  'The draft is given to you whole. It is not saved: never write files. You may read other files of',
  'the repository (Read, Grep, Glob) when the answer depends on them.',
  '',
  'Each message of the person says its mode, and the mode decides what you may do:',
  '- ask is read-only: answer it, and `edits` is `[]`, even when the message asks for a change.',
  '  Edits proposed on an ask are thrown away.',
  '- comment is acted on: propose the edits it calls for. The person sees each edit in the text, struck',
  '  through and inserted, so the reply only names the change in a few words (at most about ten), like',
  '  "Troquei REST por gRPC." or "Encurtei o parágrafo.": never quote the old or new text, never explain',
  '  unless asked, never list the edits one by one.',
  '  When a comment is only an opinion or needs a decision from the person, answer without edits.',
  '',
  'Reply in the language the person wrote in. Be brief: the reply shows in a small balloon beside the text.',
  '',
  'End your answer with exactly one fenced json block, and nothing after it:',
  '```json',
  '{ "thread": "<the thread id your task names>", "reply": "what you answer the person", "edits": [{ "old": "exact text of the draft", "new": "its replacement" }] }',
  '```',
  '`old` is copied character for character from the draft, as short as it can be while still unique,',
  "and preferably within or next to the selected passage, when there is one. `new` keeps the draft's formatting (Markdown,",
  'indentation). An empty `new` deletes `old`. `edits` is `[]` when you change nothing.',
  '',
  'The person may write again on the same thread: their next message comes to you, with the passage as it',
  'is then and the draft again only when it changed since you read it. Answer it the same way, json block and all.',
].join('\n')

// Past this, the reviser gets the part of the draft around the passage.
const MAX_DRAFT = 120_000
const WINDOW = 30_000

export type Ask = {
  /** The thread the reviser answers, named back in its json block. */
  id: string
  file: string
  draft: string
  /** The passage in the draft: working offsets, and its text there; none when the thread is about the whole document. */
  passage?: { start: number; end: number; text: string; lineStart: number; lineEnd: number; symbol?: string }
  thread: Pick<Thread, 'messages'>
}

/** The mode of the person's last message, an Excluir aside: what the reviser answering it may do. */
export function lastAsked(thread: Pick<Thread, 'mode' | 'messages'>): Mode {
  return thread.messages.findLast(one => one.from === 'user' && one.kind === undefined)?.mode ?? thread.mode
}

/** The reviser's task: the draft, the passage, and the thread so far, the last message being the one to answer. */
export function buildAsk({ id, file, draft, passage, thread }: Ask): string {
  const [last, ...before] = [...thread.messages].reverse()

  return [
    ...draftLines(file, draft, passage),
    ...(passage === undefined ? ["The person's message is about the whole document (no passage selected).", ''] : passageLines(passage)),
    ...(before.length > 0
      ? ['The conversation on it so far:', ...before.reverse().map(said), '']
      : []),
    ...askLines(id, last, passage),
  ].join('\n')
}

export type FollowUp = Ask & {
  /** The mark of the draft the reviser read last (`draftMark`); the draft goes again when it differs. */
  seen?: string
}

/**
 * The next message to a reviser resumed on its thread: what happened on the
 * thread since its last answer, which of its rounds are taken back now, the
 * passage as it is, the draft only when it changed, and the message to answer.
 */
export function buildFollowUp({ id, file, draft, passage, thread, seen }: FollowUp): string {
  const [last, ...before] = [...thread.messages].reverse()
  const since = before.slice(0, Math.max(0, before.findIndex(one => one.from === 'claude' && one.kind === undefined))).reverse()
  const undone = thread.messages.filter(one => one.from === 'claude' && one.round !== undefined && one.undone === true)

  return [
    ...(draftMark(draft) === seen ? ['The draft has not changed since you last read it.', ''] : draftLines(file, draft, passage, 'now')),
    ...(passage === undefined ? [] : passageLines(passage, 'now')),
    ...(since.length > 0 ? ['Since your last answer:', ...since.map(said), ''] : []),
    ...(undone.length > 0
      ? ['These answers of yours are taken back now; their edits are not in the draft:', ...undone.map(one => `- «${clip(one.text)}»`), '']
      : []),
    ...askLines(id, last, passage),
  ].join('\n')
}

/** A short mark of a draft: what a resumed reviser read is told apart from what it is now. */
export function draftMark(draft: string): string {
  let hash = 5381
  for (let i = 0; i < draft.length; i++) hash = ((hash << 5) + hash + draft.charCodeAt(i)) | 0

  return `${draft.length}:${(hash >>> 0).toString(36)}`
}

function draftLines(file: string, draft: string, passage: Ask['passage'], when?: 'now'): string[] {
  let shown = draft
  let cut = ''
  if (draft.length > MAX_DRAFT) {
    // With no passage, the start of the draft.
    const from = Math.max(0, (passage?.start ?? 0) - WINDOW)
    const to = Math.min(draft.length, (passage?.end ?? 0) + WINDOW)
    shown = draft.slice(from, to)
    cut = ` (an excerpt: characters ${from}-${to} of ${draft.length})`
  }

  return [`The draft of \`${file}\`${when === 'now' ? ' as it is now' : ''}${cut}:`, '<draft>', shown, '</draft>', '']
}

function askLines(id: string, last: Thread['messages'][number] | undefined, passage: Ask['passage']): string[] {
  return [
    last?.mode === 'comment' ? 'The person comments (comment: act on it):' : 'The person asks (ask: read-only, propose no edits):',
    last?.text.trim() || `${last?.mode === 'comment' ? 'Improve' : 'Explain'} this ${passage === undefined ? 'document' : 'passage'}.`,
    '',
    `Thread id: ${id}`,
  ]
}

/** One earlier message, as the reviser reads it; an Excluir or Editar is told as such, so its text is not written back. */
function said(one: Thread['messages'][number]): string {
  const then = one.undone === true ? ' (then undid it)' : ''
  if (one.kind === 'delete') return `Person deleted${then}: «${one.text}»`
  if (one.kind === 'edit') {
    const edit = one.edits?.[0]

    return `Person edited the text${then}: «${clip(edit?.old ?? '')}» became «${clip(edit?.new ?? '')}»`
  }

  return `${one.from === 'user' ? `Person (${one.mode})` : 'You'}: ${one.text}`
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

function passageLines(passage: NonNullable<Ask['passage']>, when?: 'now'): string[] {
  const lines = passage.lineStart === passage.lineEnd ? `L${passage.lineStart}` : `L${passage.lineStart}-${passage.lineEnd}`
  const where = passage.symbol === undefined ? lines : `${lines}, in ${passage.symbol}`

  return [`The selected passage${when === 'now' ? ' as it is now' : ''} (${where}):`, '<passage>', passage.text, '</passage>', '']
}

export type Proposal = { thread?: string; reply: string; edits: { old: string; new: string }[] }

/** The thread, reply and edits in a reviser's final message: its last json block, else all reply. */
export function parseProposal(answer: string): Proposal {
  const blocks = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)]
  for (const block of blocks.reverse()) {
    try {
      const value = JSON.parse(block[1]!) as { thread?: unknown; reply?: unknown; edits?: unknown }
      if (typeof value !== 'object' || value === null) continue
      const edits = Array.isArray(value.edits)
        ? value.edits.filter(
            (one): one is { old: string; new: string } =>
              typeof one?.old === 'string' && one.old !== '' && typeof one?.new === 'string',
          )
        : []
      const prose = answer.slice(0, block.index).trim()

      const reply = typeof value.reply === 'string' && value.reply.trim() !== '' ? value.reply.trim() : prose

      return typeof value.thread === 'string' ? { thread: value.thread, reply, edits } : { reply, edits }
    } catch {
      // Not the block: try the one before it.
    }
  }

  return { reply: answer.trim(), edits: [] }
}

/** Where `old` is in the draft: of several, the one nearest the passage. */
export function findEdit(draft: string, old: string, near: number): { start: number; end: number } | undefined {
  let best: number | undefined
  for (let at = draft.indexOf(old); at !== -1; at = draft.indexOf(old, at + 1)) {
    if (best === undefined || Math.abs(at - near) < Math.abs(best - near)) best = at
  }
  if (best !== undefined) return { start: best, end: best + old.length }
  // The reviser may have trimmed or re-spaced the text it copied.
  const trimmed = old.trim()
  if (trimmed !== old && trimmed !== '') return findEdit(draft, trimmed, near)

  return undefined
}
