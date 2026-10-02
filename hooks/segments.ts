// The pane draws the file as a run of blocks so annotations can be marked
// between them: Markdown ends a block at a blank line outside a code fence,
// code every few dozen lines.

import type { Syntax } from './anchor'

/** `line` is the 1-based number of the block's first line. */
export type Segment = { start: number; end: number; line: number; text: string }

// A Markdown or Code element takes at most 10,000 characters.
const MAX_SEGMENT = 9000
const CODE_LINES = 40
const FENCE = /^[ \t]*(```|~~~)/

export function syntaxOf(path: string): Syntax {
  return /\.(md|markdown|mdx)$/i.test(path) ? 'markdown' : 'code'
}

export function segment(source: string): Segment[] {
  const segments: Segment[] = []
  let start = -1
  let fence: string | null = null
  let offset = 0

  const close = (end: number) => {
    if (start === -1) return
    segments.push(...capped(source, start, end))
    start = -1
  }

  for (const line of source.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
    }
    if (line.trim() === '' && fence === null) close(offset - 1)
    else if (start === -1) start = offset
    offset += line.length + 1
  }
  close(source.length)

  return segments
}

/** Code in blocks of up to 40 lines, each cut at a line's end. */
export function chunkLines(source: string): Segment[] {
  const segments: Segment[] = []
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()

  let start = 0
  let first = 0
  while (first < lines.length) {
    let last = first
    let length = lines[first]!.length
    while (
      last + 1 < lines.length &&
      last + 1 - first < CODE_LINES &&
      length + 1 + lines[last + 1]!.length <= MAX_SEGMENT
    ) {
      last++
      length += 1 + lines[last]!.length
    }
    segments.push({ start, end: start + length, line: first + 1, text: source.slice(start, start + length) })
    start += length + 1
    first = last + 1
  }

  return segments
}

/** The index of the segment holding `offset`, or of the last one before it. */
export function segmentAt(segments: readonly Segment[], offset: number): number {
  let found = 0
  segments.forEach((one, i) => {
    if (one.start <= offset) found = i
  })

  return found
}

function capped(source: string, start: number, end: number): Segment[] {
  const text = source.slice(start, end)
  const line = lineAt(source, start)
  if (text.length <= MAX_SEGMENT) return [{ start, end, line, text }]
  const cut = text.lastIndexOf('\n', MAX_SEGMENT)
  const at = start + (cut > 0 ? cut : MAX_SEGMENT)
  const rest = source[at] === '\n' ? at + 1 : at

  return [{ start, end: at, line, text: source.slice(start, at) }, ...capped(source, rest, end)]
}

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) line++

  return line
}
