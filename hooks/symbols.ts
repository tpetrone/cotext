// Which declaration a passage of code sits in, by a scan upward for the
// nearest one indented less than it. A heuristic over common shapes in
// TypeScript/JavaScript, Python, Rust and Go, not a parser.

type Declaration = { name: string; isContainer: boolean }

const CONTAINERS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait|enum)\s+([A-Za-z_]\w*)/,
]

const FUNCTIONS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
]

const GO_FUNC = /^func\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)/
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function'])

/** The name of the declaration around `line` (1-based), as `Class.method`. */
export function enclosingSymbol(source: string, line: number): string | undefined {
  const lines = source.split('\n')
  const target = lines[line - 1]
  if (target === undefined) return undefined

  const inner = declarationAbove(lines, line - 1, indentOf(target), true)
  if (inner === undefined) return undefined
  if (inner.declaration.isContainer || inner.declaration.name.includes('.')) {
    return inner.declaration.name
  }

  const outer = declarationAbove(lines, inner.index - 1, indentOf(lines[inner.index]!), false, true)

  return outer === undefined ? inner.declaration.name : `${outer.declaration.name}.${inner.declaration.name}`
}

function declarationAbove(
  lines: readonly string[],
  from: number,
  indent: number,
  isInclusive: boolean,
  containersOnly = false,
): { index: number; declaration: Declaration } | undefined {
  for (let i = from; i >= 0; i--) {
    const text = lines[i]!
    if (text.trim() === '') continue
    // The target's own line may be the declaration; any other must enclose it.
    const encloses = (isInclusive && i === from) || indentOf(text) < indent
    if (!encloses) continue
    const declaration = declarationOn(text, containersOnly)
    if (declaration !== undefined) return { index: i, declaration }
  }

  return undefined
}

function declarationOn(text: string, containersOnly: boolean): Declaration | undefined {
  for (const pattern of CONTAINERS) {
    const name = pattern.exec(text)?.[1]
    if (name !== undefined) return { name, isContainer: true }
  }
  if (containersOnly) return undefined

  const go = GO_FUNC.exec(text)
  if (go?.[2] !== undefined) return { name: go[1] ? `${go[1]}.${go[2]}` : go[2], isContainer: false }
  for (const pattern of FUNCTIONS) {
    const name = pattern.exec(text)?.[1]
    if (name !== undefined && !NOT_METHODS.has(name)) return { name, isContainer: false }
  }

  return undefined
}

function indentOf(text: string): number {
  return /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length
}
