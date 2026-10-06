// The subagent each question or comment spawns: what it is told, and how its
// answer becomes a reply in the balloon and edits in the draft.

import type { Mode, Thread } from '../types'

export const REVISER = 'reviser'

/** The type `$.agent.spawn` names: a plugin's agent is `<plugin>:<name>`. */
export const REVISER_TYPE = `cotext:${REVISER}`

/** The reviser reads, never writes: the draft lives in the mod until Revisar. */
export const REVISER_TOOLS = ['Read', 'Grep', 'Glob'] as const

export const REVISER_PROMPT = [
  'You help a person review a document in cotext. They selected a passage of their draft and asked',
  'about it or commented on it. You answer, and on a comment you may propose edits to the draft.',
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
  "and preferably within or next to the selected passage. `new` keeps the draft's formatting (Markdown,",
  'indentation). An empty `new` deletes `old`. `edits` is `[]` when you change nothing.',
].join('\n')

// Past this, the reviser gets the part of the draft around the passage.
const MAX_DRAFT = 120_000
const WINDOW = 30_000

export type Ask = {
  /** The thread the reviser answers, named back in its json block. */
  id: string
  file: string
  draft: string
  /** The passage in the draft: working offsets, and its text there. */
  passage: { start: number; end: number; text: string; lineStart: number; lineEnd: number; symbol?: string }
  thread: Pick<Thread, 'messages'>
}

/** The mode of the person's last message: what the reviser answering it may do. */
export function lastAsked(thread: Pick<Thread, 'mode' | 'messages'>): Mode {
  return thread.messages.findLast(one => one.from === 'user')?.mode ?? thread.mode
}

/** The reviser's task: the draft, the passage, and the thread so far, the last message being the one to answer. */
export function buildAsk({ id, file, draft, passage, thread }: Ask): string {
  const lines = passage.lineStart === passage.lineEnd ? `L${passage.lineStart}` : `L${passage.lineStart}-${passage.lineEnd}`
  const where = passage.symbol === undefined ? lines : `${lines}, in ${passage.symbol}`
  let shown = draft
  let cut = ''
  if (draft.length > MAX_DRAFT) {
    const from = Math.max(0, passage.start - WINDOW)
    const to = Math.min(draft.length, passage.end + WINDOW)
    shown = draft.slice(from, to)
    cut = ` (an excerpt: characters ${from}-${to} of ${draft.length})`
  }
  const [last, ...before] = [...thread.messages].reverse()

  return [
    `The draft of \`${file}\`${cut}:`,
    '<draft>',
    shown,
    '</draft>',
    '',
    `The selected passage (${where}):`,
    '<passage>',
    passage.text,
    '</passage>',
    '',
    ...(before.length > 0
      ? ['The conversation on it so far:', ...before.reverse().map(one => `${one.from === 'user' ? `Person (${one.mode})` : 'You'}: ${one.text}`), '']
      : []),
    last?.mode === 'comment' ? 'The person comments (comment: act on it):' : 'The person asks (ask: read-only, propose no edits):',
    last?.text.trim() || (last?.mode === 'comment' ? 'Improve this passage.' : 'Explain this passage.'),
    '',
    `Thread id: ${id}`,
  ].join('\n')
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
