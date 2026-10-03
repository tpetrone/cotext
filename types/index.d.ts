export type AnnotationType =
  | 'highlight'
  | 'question'
  | 'reject'
  | 'accept'
  | 'investigate'
  | 'comment'

/** `needs_human`: Claude worked on it and handed a decision back. */
export type AnnotationStatus = 'open' | 'resolved' | 'needs_human' | 'dismissed'

/** Where an annotation sits in its file, by offsets and by the text around it. */
export type Anchor = {
  /** The annotated passage as the source file spells it. */
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

/** The lines an outside edit changed in the open file, until `at` + a while. */
export type Changed = { lineStart: number; lineEnd: number; at: number }

export type Annotation = {
  id: string
  /** Relative to the session's working directory. */
  file: string
  type: AnnotationType
  anchor: Anchor
  comment?: string
  status: AnnotationStatus
  /**
   * Why the anchor no longer holds, while the annotation stays active: its
   * file is gone and no rename was found, or its text is no longer in it.
   */
  detached?: 'file' | 'text'
  /** With `detached: 'text'`: the passage the text most likely became. */
  guess?: Guess
  /** What Claude said it did, or what it needs the user to decide. */
  resolution?: { summary: string; at: string }
  createdAt: string
}

/** The shape of `.review/review.json`. */
export type ReviewFile = { version: 1; annotations: Annotation[] }

/** Review answers without editing files; Apply may edit them. */
export type SendMode = 'review' | 'apply'

/** A review sent to Claude: ANNOTATION n is `ids[n - 1]`. */
export type Pending = { mode: SendMode; ids: string[]; turnId?: string }

/** Which annotations the queue lists and a send includes. */
export type Scope = 'file' | 'project'

/** An annotation waiting for its note in the pane's Input. */
export type Draft = { type: AnnotationType; anchor: Anchor }

/**
 * A typed edit to the file in progress: `prefix` and what the Input holds stand
 * in the file at `start`..`end`, written as it is typed; `original` is what the
 * span held before, to revert to.
 */
export type Edit = {
  kind: 'insert' | 'append' | 'open' | 'change'
  start: number
  end: number
  value: string
  original: string
  prefix: string
}

/** A selection that fits several places in the file, waiting for the user to pick one. */
export type Pick = { type: AnnotationType; anchors: Anchor[] }

declare module 'claude-code' {
  interface PluginState {
    cotext: {
      /** The file the pane shows; null before `/cotext <path>`. */
      file: string | null
      source: string
      /** Every annotation in review.json, every file's. */
      annotations: Annotation[]
      /** What the last outside edit to the open file touched; null once it fades. */
      changed: Changed | null
      /** The open file is gone from disk and no rename was found. */
      missing: boolean
      /**
       * review.json's text as last read or written, and whether it parsed:
       * a different text on disk means something else changed it.
       */
      disk: { text: string; isValid: boolean } | null
      /** The keyboard cursor, a character offset in `source`; null until a key moves it. */
      cursor: number | null
      /** Where visual mode began, an offset like `cursor`; null outside visual mode. */
      visual: number | null
      /** The insert-mode edit in progress; null outside insert mode. */
      edit: Edit | null
      /** The header's keys only (true), in full (false), or by the pane's height (null). */
      compact: boolean | null
      /** What the pane's body shows: the file, or the annotations. */
      view: 'text' | 'notes'
      draft: Draft | null
      pick: Pick | null
      /** The review in flight, from Send until its turn completes. */
      pending: Pending | null
      scope: Scope
      showResolved: boolean
    }
  }
}
