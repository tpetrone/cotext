// Where a file went: the renames git saw, read from `--name-status -z`
// output, so an annotation can follow its file after a `git mv`.

/** The `[from, to]` pairs of the renames in `git log` or `git diff` output. */
export function parseRenames(output: string): [string, string][] {
  const fields = output.split('\0').filter(field => field !== '')
  const pairs: [string, string][] = []
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]!
    if (/^[RC]\d*$/.test(status)) {
      if (status.startsWith('R')) pairs.push([fields[i + 1]!, fields[i + 2]!])
      i += 3
    } else {
      i += 2
    }
  }

  return pairs
}

/** The path `path` ends at after every rename in `renames`; itself when none. */
export function followRename(renames: ReadonlyMap<string, string>, path: string): string {
  const seen = new Set<string>()
  let at = path
  while (renames.has(at) && !seen.has(at)) {
    seen.add(at)
    at = renames.get(at)!
  }

  return at
}
