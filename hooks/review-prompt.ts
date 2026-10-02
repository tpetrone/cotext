import type { Annotation, AnnotationType, SendMode } from '../types'

/** The first words of every review prompt, how `turn.start` knows its turn. */
export const PROMPT_HEADER = 'COTEXT REVIEW'

export const RESOLVE_TOOL = 'mcp__cotext__resolve_annotations'

// What each type asks of Claude when the person left no note, and the frame
// a note is read in when they did.
const MEANING: Record<AnnotationType, string> = {
  highlight: 'Review this passage closely for problems, inconsistencies or room to improve.',
  question: 'The user has a question about this. Explain it.',
  reject: 'The user disagrees with this. Reconsider it.',
  accept: 'The user accepts this decision. Keep it.',
  investigate: 'Investigate this in depth before changing anything.',
  comment: 'The user left a comment on this.',
}

const MODE: Record<SendMode, string> = {
  review:
    'Mode: REVIEW. Answer each annotation. Do not edit files: file edits are blocked for this turn.',
  apply:
    'Mode: APPLY. You may edit the files to address the annotations, keeping accepted decisions.',
}

/**
 * The prompt a send submits: every annotation given, numbered in order and
 * grouped by file, then the mode and how to report back. ANNOTATION n is
 * `annotations[n - 1]`, so callers send them in the order they keep.
 */
export function buildReviewPrompt(annotations: readonly Annotation[], mode: SendMode): string {
  const files = [...new Set(annotations.map(one => one.file))]
  const ordered = promptOrder(annotations)
  const lines: string[] = [
    `${PROMPT_HEADER}: the user reviewed ${files.map(file => `\`${file}\``).join(', ')} and left ${count(annotations.length)}.`,
    '',
  ]

  let file: string | undefined
  ordered.forEach((one, i) => {
    if (one.file !== file) {
      file = one.file
      lines.push(`## ${file}`, '')
    }
    lines.push(
      `ANNOTATION ${i + 1}: ${one.type} (${where(one)})`,
      quote(one.anchor.selectedText),
      `Meaning: ${MEANING[one.type]}`,
    )
    if (one.comment) lines.push(`Note: ${one.comment}`)
    if (one.status === 'needs_human' && one.resolution) {
      lines.push(`Earlier you handed this back: ${one.resolution.summary}`)
    }
    lines.push('')
  })

  lines.push(
    MODE[mode],
    'Consider the annotations together rather than independently.',
    'Do not change accepted decisions unless another annotation requires it.',
    'Answer each annotation by its number.',
    `When you are done, call \`${RESOLVE_TOOL}\` once with an entry for every annotation: ` +
      '`{ n, status: "resolved" | "needs_human", summary }`, where `summary` is one line ' +
      'on what you did, or on what the user has to decide.',
  )

  return lines.join('\n')
}

/** The annotations in the order `buildReviewPrompt` numbers them. */
export function promptOrder(annotations: readonly Annotation[]): Annotation[] {
  const files = [...new Set(annotations.map(one => one.file))]

  return files.flatMap(file => annotations.filter(one => one.file === file))
}

function where(one: Annotation): string {
  const { lineStart, lineEnd, symbol } = one.anchor
  const lines = lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}-${lineEnd}`

  return symbol ? `${lines}, in ${symbol}` : lines
}

function quote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

function count(n: number): string {
  return n === 1 ? '1 annotation' : `${n} annotations`
}
