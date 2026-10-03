import type { Anchor, Guess } from '../types'

const CONTEXT = 40

// The selection is taken from the rendered pane, so it lacks the syntax the
// source has (`**bold**`, `# Heading`, `- item`, fences). Both sides are
// projected to the same plain form, and the source keeps a map from each
// plain character back to its offset.
const LINE_MARKERS = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+•◦▪][ \t]+|\d+[.)][ \t]+)*/
const SKIPPED_LINE = /^[ \t]*(?:```|~~~|([-*_])[ \t]*(?:\1[ \t]*){2,}$)/
const DROPPED = new Set(['*', '_', '`'])

// A code view draws the source as written: only whitespace is normalised.
export type Syntax = 'markdown' | 'code'

type Projection = { text: string; map: number[] }

export function project(source: string, syntax: Syntax = 'markdown'): Projection {
  const isMarkdown = syntax === 'markdown'
  let text = ''
  const map: number[] = []
  let offset = 0
  for (const line of source.split('\n')) {
    if (!isMarkdown || !SKIPPED_LINE.test(line)) {
      const markers = isMarkdown ? (LINE_MARKERS.exec(line)?.[0].length ?? 0) : 0
      for (let i = markers; i < line.length; i++) {
        const char = line[i]!
        if (isMarkdown && DROPPED.has(char)) continue
        if (/\s/.test(char)) {
          if (text.length > 0 && !text.endsWith(' ')) {
            text += ' '
            map.push(offset + i)
          }
          continue
        }
        text += char
        map.push(offset + i)
      }
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' '
        map.push(offset + line.length)
      }
    }
    offset += line.length + 1
  }

  return { text, map }
}

export type Located =
  | { kind: 'found'; anchor: Anchor }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; count: number; anchors: Anchor[] }

export type Hint = { contextBefore?: string; contextAfter?: string }

export type LocateOptions = { hint?: Hint; syntax?: Syntax }

// A selection across the pane can take the line-number gutter with it.
const GUTTER = /^[ \t]*\d+[ \t]*[│|]?[ \t]?/gm
const FIRST_NUMBER = /^[ \t]*(\d+)/

/**
 * Finds `selected` in `source`, ignoring whitespace and, for Markdown, its
 * syntax. Several matches are told apart by `hint` (an anchor's stored
 * context) when given; otherwise, or when the context ties, the answer is
 * `ambiguous`. A selection that is not found is tried again without the
 * gutter's line numbers, and the number on its first row, when it has one,
 * tells duplicates apart: the first match on or after that line wins (a
 * code view numbers each line, a Markdown view each block's first).
 */
export function locate(source: string, selected: string, options: LocateOptions = {}): Located {
  const found = locateText(source, selected, options)
  if (found.kind !== 'missing') return found

  const unguttered = selected.replace(GUTTER, '')
  if (unguttered === selected) return found
  const firstRow = selected.split('\n', 1)[0]!
  const numbered = firstRow.replace(GUTTER, '') !== firstRow
  const line = numbered ? Number(FIRST_NUMBER.exec(firstRow)![1]) : undefined

  return locateText(source, unguttered, options, line)
}

function locateText(
  source: string,
  selected: string,
  { hint, syntax }: LocateOptions,
  line?: number,
): Located {
  const needle = project(selected, syntax).text.trim()
  if (needle.length === 0) return { kind: 'missing' }

  const { text, map } = project(source, syntax)
  const starts: number[] = []
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    starts.push(at)
  }
  if (starts.length === 0) return { kind: 'missing' }

  const spans = starts.map(at => ({ start: map[at]!, end: map[at + needle.length - 1]! + 1 }))
  if (spans.length === 1) return { kind: 'found', anchor: anchorAt(source, spans[0]!) }
  if (line !== undefined) {
    const after = spans.filter(span => lineOf(source, span.start) >= line)
    const nearest = Math.min(...after.map(span => lineOf(source, span.start)))
    const onIt = after.filter(span => lineOf(source, span.start) === nearest)
    if (onIt.length === 1) return { kind: 'found', anchor: anchorAt(source, onIt[0]!) }
  }
  if (hint === undefined) return ambiguous(source, spans)

  const scored = spans.map(span => ({ span, score: contextScore(source, span, hint) }))
  const best = Math.max(...scored.map(one => one.score))
  const winners = scored.filter(one => one.score === best)
  if (winners.length !== 1) return ambiguous(source, winners.map(one => one.span))

  return { kind: 'found', anchor: anchorAt(source, winners[0]!.span) }
}

function ambiguous(source: string, spans: { start: number; end: number }[]): Located {
  return { kind: 'ambiguous', count: spans.length, anchors: spans.map(span => anchorAt(source, span)) }
}

/** Whether the anchor's offsets still hold its text in `source`. */
export function isLive(source: string, anchor: Anchor): boolean {
  return source.slice(anchor.start, anchor.end) === anchor.selectedText
}

/**
 * The anchor again in a changed `source`: the original range, then a search
 * told apart by the stored context. Offsets and lines are the new ones; the
 * rest of the anchor (its symbol) is kept.
 */
export function relocate(source: string, anchor: Anchor, syntax: Syntax = 'markdown'): Anchor | null {
  if (isLive(source, anchor)) {
    const lineStart = lineOf(source, anchor.start)
    const lineEnd = lineOf(source, anchor.end - 1)

    return lineStart === anchor.lineStart && lineEnd === anchor.lineEnd
      ? anchor
      : { ...anchor, lineStart, lineEnd }
  }
  // The stored text is the source's own spelling, so it is searched as code.
  const found = locate(source, anchor.selectedText, { hint: anchor, syntax: 'code' })
  const again = found.kind === 'found' ? found : locate(source, anchor.selectedText, { hint: anchor, syntax })
  if (again.kind !== 'found') return null

  return anchor.symbol === undefined ? again.anchor : { ...again.anchor, symbol: anchor.symbol }
}

/**
 * Where a rewritten passage most likely went: between the stored context on
 * both sides when both are still in `source`, else the line sharing the most
 * words with the old text. Approximate by nature; null when nothing fits.
 */
export function guessNear(source: string, anchor: Anchor): Guess | null {
  const before = anchor.contextBefore.trimEnd().slice(-20)
  const after = anchor.contextAfter.trimStart().slice(0, 20)
  const from = before === '' ? -1 : source.indexOf(before)
  const to = after === '' ? -1 : source.indexOf(after, from === -1 ? 0 : from + before.length)
  let start = -1
  let end = -1
  if (from !== -1 && to !== -1) {
    start = from + before.length
    end = to
  } else {
    const words = new Set(anchor.selectedText.toLowerCase().split(/\W+/).filter(word => word.length > 2))
    let best = 0
    let offset = 0
    for (const line of source.split('\n')) {
      const shared = new Set(line.toLowerCase().split(/\W+/).filter(word => words.has(word))).size
      if (shared > best) {
        best = shared
        start = offset
        end = offset + line.length
      }
      offset += line.length + 1
    }
    if (best === 0 || best * 2 < words.size) return null
  }
  while (start < end && /\s/.test(source[start]!)) start++
  while (end > start && /\s/.test(source[end - 1]!)) end--
  if (end <= start || end - start > anchor.selectedText.length * 4 + 200) return null

  return {
    text: source.slice(start, end),
    start,
    end,
    lineStart: lineOf(source, start),
    lineEnd: lineOf(source, end - 1),
  }
}

export function lineOf(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++
  }

  return line
}

export function anchorAt(source: string, span: { start: number; end: number }): Anchor {
  return {
    selectedText: source.slice(span.start, span.end),
    start: span.start,
    end: span.end,
    lineStart: lineOf(source, span.start),
    lineEnd: lineOf(source, span.end - 1),
    contextBefore: source.slice(Math.max(0, span.start - CONTEXT), span.start),
    contextAfter: source.slice(span.end, span.end + CONTEXT),
  }
}

function contextScore(source: string, span: { start: number; end: number }, hint: Hint): number {
  const before = source.slice(0, span.start)
  const after = source.slice(span.end)

  return (
    commonSuffix(before, hint.contextBefore ?? '') + commonPrefix(after, hint.contextAfter ?? '')
  )
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++

  return n
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++

  return n
}
