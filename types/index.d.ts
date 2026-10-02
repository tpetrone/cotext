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

export type Annotation = {
  id: string
  /** Relative to the session's working directory. */
  file: string
  type: AnnotationType
  anchor: Anchor
  comment?: string
  status: AnnotationStatus
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

declare module 'claude-code' {
  interface PluginState {
    cotext: {
      /** The file the pane shows; null before `/cotext <path>`. */
      file: string | null
      source: string
      /** Every annotation in review.json, every file's. */
      annotations: Annotation[]
      draft: Draft | null
      /** The review in flight, from Send until its turn completes. */
      pending: Pending | null
      scope: Scope
      showResolved: boolean
    }
  }
}
