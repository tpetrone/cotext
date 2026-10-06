// The draft a review edits: the file as it was read (the base) and the
// changes made over it, each a hunk on base offsets. Nothing here touches the
// disk; Revisar writes `working(base, hunks)` and the draft starts over from it.
//
// Three texts are in play. The base never moves until Revisar, so threads
// anchor in it. The working text is the base with every hunk applied: what
// Revisar saves and what the reviser reads. The display text is the base with
// each hunk's removed text followed by its inserted text: what the page draws,
// struck through and coloured.

import type { Hunk } from '../types'

/** The base with every hunk applied. */
export function working(base: string, hunks: readonly Hunk[]): string {
  let text = ''
  let at = 0
  for (const one of hunks) {
    text += base.slice(at, one.start) + one.text
    at = one.end
  }

  return text + base.slice(at)
}

export type DisplaySpan = { kind: 'del' | 'ins'; start: number; end: number; hunk: string }

/** The base with each hunk's removed text then its inserted text, and where each lies. */
export function display(base: string, hunks: readonly Hunk[]): { text: string; spans: DisplaySpan[] } {
  let text = ''
  let at = 0
  const spans: DisplaySpan[] = []
  for (const one of hunks) {
    text += base.slice(at, one.start)
    const removed = base.slice(one.start, one.end)
    if (removed !== '') spans.push({ kind: 'del', start: text.length, end: text.length + removed.length, hunk: one.id })
    text += removed
    if (one.text !== '') spans.push({ kind: 'ins', start: text.length, end: text.length + one.text.length, hunk: one.id })
    text += one.text
    at = one.end
  }

  return { text: text + base.slice(at), spans }
}

/**
 * Which side of a range an offset bounds. A range's start that falls on or in
 * a hunk takes the hunk in; so does its end: ranges are inclusive of the
 * changes at their edges.
 */
export type Side = 'start' | 'end'

/** A base offset in the display text. */
export function baseToDisplay(hunks: readonly Hunk[], pos: number, side: Side): number {
  let delta = 0
  for (const one of hunks) {
    const width = one.end - one.start + one.text.length
    const before = one.start + delta
    if (pos < one.start) return pos + delta
    if (pos === one.start && (side === 'start' || one.start < one.end)) return before
    if (pos < one.end) return side === 'start' ? before : before + width
    if (pos === one.end && side === 'start' && one.start < one.end) return before + width
    delta += one.text.length
  }

  return pos + delta
}

/** A display offset in the base: inserted text has no base, so it maps to its hunk's edge. */
export function displayToBase(hunks: readonly Hunk[], pos: number, side: Side): number {
  let delta = 0
  for (const one of hunks) {
    const start = one.start + delta
    const removedEnd = start + (one.end - one.start)
    const end = removedEnd + one.text.length
    if (pos <= start) return pos - delta
    if (pos <= removedEnd) return one.start + (pos - start)
    if (pos < end) return side === 'start' ? one.start : one.end
    delta += one.text.length
  }

  return pos - delta
}

/** A display offset in the working text: removed text is gone there, so it maps to where it was. */
export function displayToWorking(hunks: readonly Hunk[], pos: number): number {
  let shift = 0
  let delta = 0
  for (const one of hunks) {
    const start = one.start + delta
    const removed = one.end - one.start
    if (pos <= start) return pos - shift
    if (pos <= start + removed) return start - shift
    if (pos < start + removed + one.text.length) return pos - shift - removed
    delta += one.text.length
    shift += removed
  }

  return pos - shift
}

/** A base offset in the working text; one inside a hunk maps to the hunk's edge on `side`. */
export function baseToWorking(hunks: readonly Hunk[], pos: number, side: Side): number {
  let delta = 0
  for (const one of hunks) {
    if (pos < one.start) return pos + delta
    if (pos === one.start && (side === 'start' || one.start < one.end)) return pos + delta
    if (pos < one.end || (pos === one.end && one.start === one.end)) {
      return one.start + delta + (side === 'start' ? 0 : one.text.length)
    }
    delta += one.text.length - (one.end - one.start)
  }

  return pos + delta
}

/** A working offset in the base; one inside inserted text maps to its hunk's edge on `side`. */
export function workingToBase(hunks: readonly Hunk[], pos: number, side: Side): number {
  let delta = 0
  for (const one of hunks) {
    const start = one.start + delta
    const end = start + one.text.length
    if (pos < start) return pos - delta
    if (pos === start && (side === 'start' || start < end)) return one.start
    if (pos < end) return side === 'start' ? one.start : one.end
    if (pos === end) return one.end
    delta += one.text.length - (one.end - one.start)
  }

  return pos - delta
}

/**
 * Replaces `[from, to)` of the working text with `text`. Every hunk the range
 * touches is folded into the change, which is then cut down to the words that
 * differ from the base, so it shows as small changes rather than a block.
 */
export function applyEdit(
  base: string,
  hunks: readonly Hunk[],
  from: number,
  to: number,
  text: string,
  threads: readonly string[] = [],
  newId: () => string = randomId,
  rounds: readonly string[] = [],
): Hunk[] {
  const work = working(base, hunks)
  let delta = 0
  const placed = hunks.map(one => {
    const start = one.start + delta
    delta += one.text.length - (one.end - one.start)

    return { one, start, end: start + one.text.length }
  })
  const touched = placed.filter(({ start, end }) => start <= to && end >= from)
  const wFrom = Math.min(from, ...touched.map(one => one.start))
  const wTo = Math.max(to, ...touched.map(one => one.end))
  const bFrom = workingToBase(hunks, wFrom, 'start')
  const bTo = workingToBase(hunks, wTo, 'end')
  const replacement = work.slice(wFrom, from) + text + work.slice(to, wTo)
  const tags = [...new Set([...touched.flatMap(({ one }) => one.threads), ...threads])]
  const madeBy = [...new Set([...touched.flatMap(({ one }) => one.rounds ?? []), ...rounds])]
  const kept = hunks.filter(one => !touched.some(t => t.one === one))
  const made = diffHunks(base.slice(bFrom, bTo), replacement, bFrom).map(one => ({
    id: newId(),
    ...one,
    threads: tags,
    ...(madeBy.length > 0 ? { rounds: madeBy } : {}),
  }))

  return [...kept, ...made].sort((a, b) => a.start - b.start || a.end - b.end)
}

// Words, runs of whitespace, and single other characters: what a change is cut into.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
// Past this many tokens a side, the change stays one block.
const MAX_TOKENS = 1500

/** `was` → `now`, as base hunks from `offset`: the token runs that differ. */
export function diffHunks(was: string, now: string, offset: number): { start: number; end: number; text: string }[] {
  if (was === now) return []
  const left = was.match(TOKEN) ?? []
  const right = now.match(TOKEN) ?? []
  // Whole tokens alike at either end are left out of the comparison.
  let head = 0
  let skipped = 0
  while (head < left.length && head < right.length && left[head] === right[head]) skipped += left[head++]!.length
  let tail = 0
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) {
    tail++
  }
  const from = offset + skipped
  if (left.length - head - tail > MAX_TOKENS || right.length - head - tail > MAX_TOKENS) {
    const kept = right.slice(right.length - tail).join('').length

    return [{ start: from, end: offset + was.length - kept, text: now.slice(skipped, now.length - kept) }]
  }
  return lcsHunks(left.slice(head, left.length - tail), right.slice(head, right.length - tail), from, was, offset)
}

function lcsHunks(
  left: string[],
  right: string[],
  from: number,
  was: string,
  offset: number,
): { start: number; end: number; text: string }[] {
  // Longest common subsequence of tokens, then the runs between its matches.
  const n = left.length
  const m = right.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const hunks: { start: number; end: number; text: string }[] = []
  let i = 0
  let j = 0
  let at = from
  let open: { start: number; end: number; text: string } | null = null
  const flush = () => {
    if (open !== null && (open.start !== open.end || open.text !== '')) hunks.push(open)
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && left[i] === right[j]) {
      flush()
      at += left[i]!.length
      i++
      j++
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      open ??= { start: at, end: at, text: '' }
      open.text += right[j]!
      j++
    } else {
      open ??= { start: at, end: at, text: '' }
      at += left[i]!.length
      open.end = at
      i++
    }
  }
  flush()

  return absorbSpaces(hunks, was, offset)
}

// A lone space kept between two changes reads as noise: the changes join across it.
function absorbSpaces(
  hunks: { start: number; end: number; text: string }[],
  was: string,
  offset: number,
): { start: number; end: number; text: string }[] {
  const joined: { start: number; end: number; text: string }[] = []
  for (const one of hunks) {
    const last = joined.at(-1)
    const between = last === undefined ? null : was.slice(last.end - offset, one.start - offset)
    if (last !== undefined && between !== null && /^\s{0,1}$/.test(between) && !between.includes('\n')) {
      last.text += between + one.text
      last.end = one.end
    } else {
      joined.push({ ...one })
    }
  }

  return joined
}

export function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Some of the hunks taken into the base, as an Aceitar does: the new base,
 * and the other hunks moved onto it.
 */
export function acceptHunks(base: string, hunks: readonly Hunk[], ids: readonly string[]): { base: string; hunks: Hunk[] } {
  const taken = hunks.filter(one => ids.includes(one.id))
  let delta = 0
  const rest: Hunk[] = []
  for (const one of hunks) {
    if (ids.includes(one.id)) delta += one.text.length - (one.end - one.start)
    else rest.push({ ...one, start: one.start + delta, end: one.end + delta })
  }

  return { base: working(base, taken), hunks: rest }
}
