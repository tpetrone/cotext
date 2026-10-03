// Where vim-like keys take a cursor in the source, as character offsets.

const isWord = (char: string | undefined): boolean => char !== undefined && /\w/.test(char)

/** The offsets of the line holding `at`: its first character and the newline ending it. */
export function lineBounds(source: string, at: number): { start: number; end: number } {
  const start = source.lastIndexOf('\n', at - 1) + 1
  const newline = source.indexOf('\n', at)

  return { start, end: newline === -1 ? source.length : newline }
}

/** Where a vim-like motion takes the cursor from `at`; `source` has at least one character. */
export function moved(source: string, at: number, motion: string): number {
  const last = source.length - 1
  const here = lineBounds(source, at)
  let to = at
  switch (motion) {
    case 'left':
      to = at - 1
      break
    case 'right':
      to = at + 1
      break
    case 'home':
      to = here.start
      break
    case 'tail':
      to = Math.max(here.start, here.end - 1)
      break
    case 'top':
      to = 0
      break
    case 'bottom':
      to = last
      break
    case 'down':
    case 'up': {
      const column = at - here.start
      const next =
        motion === 'down' ? (here.end >= source.length ? null : lineBounds(source, here.end + 1)) : here.start === 0 ? null : lineBounds(source, here.start - 1)
      if (next !== null) to = Math.min(next.start + column, Math.max(next.start, next.end - 1))
      break
    }
    case 'word':
      while (to < last && isWord(source[to])) to++
      while (to < last && !isWord(source[to])) to++
      break
    case 'back':
      to--
      while (to > 0 && !isWord(source[to])) to--
      while (to > 0 && isWord(source[to - 1])) to--
      break
  }

  return Math.max(0, Math.min(last, to))
}

