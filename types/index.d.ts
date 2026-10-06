/**
 * What a message asks of Claude. `ask` is read-only: Claude answers and the
 * draft is never touched. `comment` writes: Claude acts on the passage and
 * may change the draft.
 */
export type Mode = 'ask' | 'comment'

/** Where a passage sits in a text, by offsets and by the text around it. */
export type Anchor = {
  /** The passage as the text spells it. */
  selectedText: string
  start: number
  end: number
  /** 1-based, inclusive. */
  lineStart: number
  lineEnd: number
  contextBefore: string
  contextAfter: string
  /** The declaration the passage sits in, in code (`BookmarkSyncService.sync`). */
  symbol?: string
}

/** Where a rewritten passage most likely went: approximate, never an anchor. */
export type Guess = { text: string; start: number; end: number; lineStart: number; lineEnd: number }

/**
 * One change of the draft: base `[start, end)` becomes `text`. Hunks are kept
 * sorted and never overlap; an empty `text` is a deletion, an empty range an insertion.
 */
export type Hunk = {
  id: string
  start: number
  end: number
  text: string
  /** The threads whose proposals made it; none for an Excluir. */
  threads: string[]
  /** The rounds whose edits made it, for Aceitar on one round. */
  rounds?: string[]
}

/**
 * One edit a reviser proposed in a round, and whether it reached the draft.
 * `before` and `after` are the working text around where it landed, kept so
 * the round can find it again to take it back (a deletion leaves no text of its own).
 */
export type RoundEdit = { old: string; new: string; applied: boolean; before?: string; after?: string }

/** One turn of a thread. Claude's carry the mode of the message they answer. */
export type Message = {
  from: 'user' | 'claude'
  text: string
  at: string
  mode: Mode
  /** On Claude's answer to a comment: the round it closes, which Desfazer and Refazer name. */
  round?: string
  /** What the reviser proposed in that round, applied or not. */
  edits?: RoundEdit[]
  /** The round's applied edits are taken back. */
  undone?: boolean
  /** The round's applied edits are in the file as last saved by Revisar. */
  onDisk?: boolean
}

/**
 * A question or comment on a passage and what Claude said back: the balloon
 * in the page's right column. Anchored in the base, which holds until Revisar.
 */
export type Thread = {
  id: string
  /** The mode it was opened in; each message carries its own. */
  mode: Mode
  start: number
  end: number
  /** The passage as the person selected it. */
  quote: string
  messages: Message[]
  /** `thinking` while a reviser runs for it; `error` when the last one failed. */
  status: 'thinking' | 'idle' | 'error'
  /** The reviser running for it, matched by its `turn.complete`. */
  agentId?: string
  /** Its passage is no longer in the file, after the file changed on disk. */
  detached?: boolean
  /** Its balloon shows only its head. */
  collapsed?: boolean
  /** About the whole document, no passage: anchored at 0..0, never marked in the text nor detached. */
  scope?: 'doc'
}

/** One state of the draft for Desfazer and Refazer: the hunks, and the rounds taken back then. */
export type Step = { hunks: Hunk[]; undone: string[] }

/** One Revisar: what each change removed and added, and the threads that proposed it. */
export type Accepted = {
  at: string
  changes: { removed: string; added: string; threads: string[] }[]
}

/** Where the review page's server listens, and the token its routes take. */
export type Server = { port: number; token: string }

declare module 'claude-code' {
  interface PluginState {
    cotext: {
      /** The file under review; null before `/cotext <path>`. */
      file: string | null
      /** The file as it was read: the draft's base. Nothing is written until Revisar. */
      base: string
      hunks: Hunk[]
      /** The hunks as they were before each change, for Desfazer; newest last. */
      past: Step[]
      /** What Desfazer took back, for Refazer; newest last. */
      future: Step[]
      threads: Thread[]
      /** What Revisar wrote to the open file, oldest first; kept in its journal under `.review/`. */
      accepted: Accepted[]
      /** The file on disk changed while the draft held changes: Revisar would overwrite it. */
      stale: boolean
      /** The open file is gone from disk. */
      missing: boolean
      /** The review page's server, kept across reloads so an open tab reconnects. */
      server: Server | null
    }
  }
}
