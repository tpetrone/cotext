import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Anchor, Annotation, AnnotationType, SendMode } from '../types'
import { isLive, locate, relocate } from './anchor'
import { PROMPT_HEADER, RESOLVE_TOOL, buildReviewPrompt, promptOrder } from './review-prompt'
import { chunkLines, segment, segmentAt, syntaxOf } from './segments'
import type { Segment } from './segments'
import { REVIEW_PATH, parseReview, serializeReview } from './store'
import { enclosingSymbol } from './symbols'

const PANE = 'cotext'

const fileAtom = atom({ plugin: 'cotext', key: 'file' } as const, null)
const sourceAtom = atom({ plugin: 'cotext', key: 'source' } as const, '')
const annotationsAtom = atom({ plugin: 'cotext', key: 'annotations' } as const, [])
const draftAtom = atom({ plugin: 'cotext', key: 'draft' } as const, null)
const pendingAtom = atom({ plugin: 'cotext', key: 'pending' } as const, null)
const scopeAtom = atom({ plugin: 'cotext', key: 'scope' } as const, 'file')
const showResolvedAtom = atom({ plugin: 'cotext', key: 'showResolved' } as const, false)

type Mark = { type: AnnotationType; hotkey: string; label: string; tag: string; color: string }

// `?` cannot be a hotkey (one digit or lowercase letter), so q stands for it.
const MARKS: readonly Mark[] = [
  { type: 'highlight', hotkey: 'h', label: 'highlight', tag: 'H', color: 'magenta' },
  { type: 'question', hotkey: 'q', label: 'question', tag: '?', color: 'yellow' },
  { type: 'reject', hotkey: 'x', label: 'reject', tag: 'X', color: 'red' },
  { type: 'accept', hotkey: 'a', label: 'accept', tag: 'A', color: 'green' },
  { type: 'investigate', hotkey: 'i', label: 'investigate', tag: 'I', color: 'cyan' },
  { type: 'comment', hotkey: 'c', label: 'comment', tag: 'C', color: 'blue' },
]
const markOf = (type: AnnotationType): Mark => MARKS.find(one => one.type === type)!

// Highlight and accept need no words; the rest ask for a note.
const ASKS_NOTE: ReadonlySet<AnnotationType> = new Set(['question', 'reject', 'investigate', 'comment'])

// The tools a Review turn may not run, and the path argument each edits.
const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Whether an annotation still waits on someone: the queue and a send take these. */
const isActive = (one: Annotation): boolean => one.status === 'open' || one.status === 'needs_human'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cotext',
      description: 'Review a file: select text, annotate it, send the review to Claude',
      argumentHint: '<file>',
    })
    await $.tool.register({
      name: 'resolve_annotations',
      description:
        'Report what became of the annotations of a cotext review the user sent: one entry per ' +
        'annotation, by its number in the review. Call it once, when done with the review.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                n: { type: 'integer', description: 'The ANNOTATION number in the review.' },
                status: { type: 'string', enum: ['resolved', 'needs_human'] },
                summary: {
                  type: 'string',
                  description: 'One line: what you did, or what the user has to decide.',
                },
              },
              required: ['n', 'status', 'summary'],
            },
          },
        },
        required: ['items'],
      },
    })

    return next(e)
  })

  on('command.run', { command: 'cotext' }, async ($, e) => {
    const path = e.args.trim().replace(/^@/, '').replace(/^["']|["']$/g, '').replace(/^\.\//, '')
    if (path === '') {
      const file = await read($, fileAtom)
      if (file === null) return { text: 'Usage: /cotext <file>' }
      await $.ui.open({ id: PANE, title: `cotext · ${file}`, focus: true })

      return { text: `Reviewing ${file}.` }
    }

    const opened = await openFile($, path)
    if (typeof opened === 'string') return { text: opened }

    return { text: `Reviewing ${path} (${opened} active annotation${opened === 1 ? '' : 's'}).` }
  })

  // Review turns may not edit; any edit to the open file re-anchors it.
  on('tool.call', async ($, e, next) => {
    // Registered at run time, so the build's tool table does not name it.
    if (String(e.tool) === RESOLVE_TOOL) return { result: await resolveAnnotations($, e) }

    const argument = EDIT_TOOLS[e.tool]
    if (argument === undefined) return next(e)

    const pending = await read($, pendingAtom)
    if (pending?.mode === 'review' && pending.turnId !== undefined) {
      return {
        deny:
          'cotext: this is a Review turn. Answer the annotations without editing files; ' +
          'the user can send the review again as Apply.',
      }
    }

    const ran = await next(e)
    const path = (e as Record<string, unknown>)[argument]
    if (ran.deny === undefined && typeof path === 'string' && (await isOpenFile($, path))) {
      await refresh($)
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const pending = await read($, pendingAtom)
    if (pending !== null && pending.turnId === undefined && e.text.includes(PROMPT_HEADER)) {
      await update($, pendingAtom, value => (value === null ? null : { ...value, turnId: e.turnId }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const pending = await read($, pendingAtom)
    if (e.agentId !== undefined || pending?.turnId !== e.turnId) return done

    await update($, pendingAtom, () => null)
    // Catches edits made some other way than Edit or Write (a Bash sed).
    await refresh($)
    const sent = (await read($, annotationsAtom)).filter(one => pending.ids.includes(one.id))
    const resolved = sent.filter(one => one.status === 'resolved').length
    const needsYou = sent.filter(one => one.status === 'needs_human').length
    const untouched = sent.length - resolved - needsYou
    void $.ui.toast(
      `cotext: ${resolved} resolved, ${needsYou} need you` +
        (untouched > 0 ? `, ${untouched} not reported back` : '') +
        '.',
    )

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)

      return <Text>cotext reviews on the terminal or desktop.</Text>
    }
    const { Box, Text, Markdown, Code, Button, Input } = $.ui.resolve(e)
    const file = await read($, fileAtom)
    if (file === null) return <Text dimColor>Run /cotext &lt;file&gt; to start a review.</Text>

    const source = await read($, sourceAtom)
    const all = await read($, annotationsAtom)
    const draft = await read($, draftAtom)
    const pending = await read($, pendingAtom)
    const scope = await read($, scopeAtom)
    const showResolved = await read($, showResolvedAtom)

    const isMarkdown = syntaxOf(file) === 'markdown'
    const segments = isMarkdown ? segment(source) : chunkLines(source)
    const here = all.filter(one => one.file === file)
    const bySegment = new Map<number, Annotation[]>()
    for (const one of here.filter(isActive)) {
      if (!isLive(source, one.anchor)) continue
      const at = segmentAt(segments, one.anchor.end - 1)
      bySegment.set(at, [...(bySegment.get(at) ?? []), one])
    }

    const listed = scope === 'file' ? here : all
    const active = listed.filter(isActive)
    const resolved = listed.filter(one => one.status === 'resolved')
    const files = [...new Set(listed.map(one => one.file))]
    const width = Math.max(20, e.props.bodyColumns - 14)
    const where = scope === 'project' ? 'project' : file
    const suffix = scope === 'project' ? ' project' : ''

    const row = (one: Annotation) => {
      const mark = markOf(one.type)
      const live = one.file !== file || isLive(source, one.anchor)
      const symbol = one.anchor.symbol ? `${one.anchor.symbol}  ` : ''
      const label = `[${mark.tag}] L${one.anchor.lineStart}  ${symbol}${excerpt(one.comment ?? one.anchor.selectedText, width)}`

      return (
        <Box key={`row-${one.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button
              key={`go-${one.id}`}
              plain
              dimColor={!live}
              onPress={() => goTo($, one)}
            >
              {live ? label : `${label} (detached)`}
            </Button>
            <Button key={`dismiss-${one.id}`} plain dimColor onPress={() => dismiss($, one.id)}>
              ×
            </Button>
          </Box>
          {one.status === 'needs_human' && one.resolution && (
            <Text color="yellow">
              {'    ↳ '}
              {excerpt(one.resolution.summary, width)}
            </Text>
          )}
        </Box>
      )
    }

    const group = (list: readonly Annotation[]) =>
      scope === 'file'
        ? list.map(row)
        : files
            .filter(name => list.some(one => one.file === name))
            .map(name => (
              <Box key={`file-${name}`} flexDirection="column">
                <Text underline>{name}</Text>
                {list.filter(one => one.file === name).map(row)}
              </Box>
            ))

    return (
      <Box flexDirection="column">
        {e.viewport?.isFullscreen === false && (
          <Text color="yellow">Selecting text needs the fullscreen terminal.</Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {MARKS.map(mark => (
            <Button key={mark.type} hotkey={mark.hotkey} plain onPress={() => startMark($, mark.type)}>
              {mark.label}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="send-review" hotkey="s" variant="primary" onPress={() => sendReview($, 'review')}>
            {`Review${suffix}`}
          </Button>
          <Button key="send-apply" hotkey="p" onPress={() => sendReview($, 'apply')}>
            {`Apply${suffix}`}
          </Button>
          <Button
            key="scope"
            hotkey="f"
            plain
            dimColor
            onPress={() => update($, scopeAtom, value => (value === 'file' ? 'project' : 'file'))}
          >
            {scope === 'file' ? 'this file' : 'project'}
          </Button>
        </Box>

        {pending !== null && (
          <Box flexDirection="row" columnGap={1}>
            <Text color="cyan">
              Claude is on {pending.ids.length} annotation{pending.ids.length === 1 ? '' : 's'} (
              {pending.mode === 'review' ? 'review: edits blocked' : 'apply'})…
            </Text>
            <Button key="release" plain dimColor onPress={() => update($, pendingAtom, () => null)}>
              release
            </Button>
          </Box>
        )}

        {draft !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>“{excerpt(draft.anchor.selectedText, width)}”</Text>
            <Box flexDirection="row" columnGap={1}>
              <Input
                key="note"
                label={`${markOf(draft.type).tag} `}
                placeholder={draft.type === 'comment' ? 'comment' : 'note (optional)'}
                submitLabel="save"
                autoFocus
                onSubmit={value => saveDraft($, value)}
              />
              <Button key="cancel" plain dimColor onPress={() => update($, draftAtom, () => null)}>
                cancel
              </Button>
            </Box>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            REVIEW · {where} · {active.length} active
          </Text>
          {group(active.filter(one => one.status === 'needs_human'))}
          {group(active.filter(one => one.status === 'open'))}
          {resolved.length > 0 && (
            <Button
              key="resolved"
              hotkey="v"
              plain
              dimColor
              onPress={() => update($, showResolvedAtom, value => !value)}
            >
              {`${resolved.length} resolved ${showResolved ? '▾' : '▸'}`}
            </Button>
          )}
          {showResolved &&
            resolved.map(one => (
              <Text key={`done-${one.id}`} color="green" wrap="truncate-end">
                ✓ [{markOf(one.type).tag}] L{one.anchor.lineStart}{' '}
                {excerpt(one.resolution?.summary ?? one.anchor.selectedText, width)}
              </Text>
            ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {segments.map((one, i) => (
            <Box key={`seg-${i}`} flexDirection="column" marginBottom={isMarkdown ? 1 : 0}>
              {isMarkdown ? (
                <Markdown text={one.text} />
              ) : (
                <Code source={one.text} path={file} startLine={one.line} />
              )}
              {(bySegment.get(i) ?? []).map(mark => (
                <Text color={markOf(mark.type).color}>
                  {'  ^ '}
                  {markOf(mark.type).tag} {excerpt(mark.comment ?? mark.anchor.selectedText, width)}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}

/** Records what Claude reports for each annotation of the review in flight. */
async function resolveAnnotations($: EngineInterface, input: unknown): Promise<string> {
  const pending = await read($, pendingAtom)
  if (pending === null) {
    return 'No cotext review is waiting on you; nothing was recorded.'
  }
  const items = (input as { items?: unknown }).items
  const entries: unknown[] = Array.isArray(items) ? items : []
  const at = new Date().toISOString()
  const changes = new Map<string, { status: 'resolved' | 'needs_human'; summary: string }>()
  const unknown: unknown[] = []
  for (const item of entries) {
    const { n, status, summary } = (item ?? {}) as { n?: unknown; status?: unknown; summary?: unknown }
    const id = typeof n === 'number' ? pending.ids[n - 1] : undefined
    if (id === undefined || (status !== 'resolved' && status !== 'needs_human')) {
      unknown.push(n)
      continue
    }
    changes.set(id, { status, summary: typeof summary === 'string' ? summary : '' })
  }

  const next = await update($, annotationsAtom, list =>
    list.map(one => {
      const change = changes.get(one.id)

      return change === undefined
        ? one
        : { ...one, status: change.status, resolution: { summary: change.summary, at } }
    }),
  )
  await saveReview($, next)

  const missing = pending.ids.length - changes.size
  const notes = [
    `Recorded ${changes.size} of ${pending.ids.length} annotations.`,
    ...(unknown.length > 0 ? [`Not recognised: ${unknown.map(String).join(', ')}.`] : []),
    ...(missing > 0 ? [`${missing} annotations have no entry yet.`] : []),
  ]

  return notes.join(' ')
}

/**
 * Reads `path` into the pane with its annotations re-anchored, and opens the
 * pane. Answers how many annotations are active there, or why it could not.
 */
async function openFile($: EngineInterface, path: string): Promise<number | string> {
  if (!(await $.fs.exists(path))) return `No such file: ${path}`
  let source: string
  let annotations: Annotation[]
  try {
    source = await $.fs.read(path)
    annotations = await loadReview($)
  } catch (error) {
    return `cotext: ${error instanceof Error ? error.message : String(error)}`
  }

  const placed = reanchor(annotations, path, source)
  await update($, fileAtom, () => path)
  await update($, sourceAtom, () => source)
  await update($, annotationsAtom, () => placed)
  await update($, draftAtom, () => null)
  await $.ui.open({ id: PANE, title: `cotext · ${path}`, focus: true })

  return placed.filter(one => one.file === path && isActive(one)).length
}

/** Reads the open file again and moves its annotations with the text. */
async function refresh($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null || !(await $.fs.exists(file))) return
  const source = await $.fs.read(file)
  if (source === (await read($, sourceAtom))) return

  await update($, sourceAtom, () => source)
  const before = await read($, annotationsAtom)
  const after = await update($, annotationsAtom, list => reanchor(list, file, source))
  if (after.some((one, i) => one !== before[i])) await saveReview($, after)
}

// Offsets go stale when the file changes, between reviews or under an edit.
function reanchor(annotations: Annotation[], file: string, source: string): Annotation[] {
  const syntax = syntaxOf(file)

  return annotations.map(one => {
    if (one.file !== file || !isActive(one)) return one
    const anchor = relocate(source, one.anchor, syntax)

    return anchor === null || anchor === one.anchor ? one : { ...one, anchor }
  })
}

async function isOpenFile($: EngineInterface, path: string): Promise<boolean> {
  const file = await read($, fileAtom)
  if (file === null) return false
  try {
    const [edited, open] = await Promise.all([
      $.fs.stat(path, { resolve: true }),
      $.fs.stat(file, { resolve: true }),
    ])

    return edited.realPath !== undefined && edited.realPath === open.realPath
  } catch {
    return false
  }
}

async function goTo($: EngineInterface, one: Annotation): Promise<void> {
  if (one.file !== (await read($, fileAtom))) {
    const opened = await openFile($, one.file)
    if (typeof opened === 'string') return void $.ui.toast(opened)
  }
  const source = await read($, sourceAtom)
  const current = (await read($, annotationsAtom)).find(each => each.id === one.id) ?? one
  if (!isLive(source, current.anchor)) {
    return void $.ui.toast('This annotation lost its place in the file.')
  }
  const segments: Segment[] = syntaxOf(one.file) === 'markdown' ? segment(source) : chunkLines(source)
  await $.ui.scroll({
    in: PANE,
    to: { key: `seg-${segmentAt(segments, current.anchor.start)}` },
    block: 'start',
  })
}

async function startMark($: EngineInterface, type: AnnotationType): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const selected = await $.ui.selection()
  if (selected === undefined || selected.text.trim() === '') {
    void $.ui.toast('Select text in the pane first.')

    return
  }

  const source = await read($, sourceAtom)
  const syntax = syntaxOf(file)
  const found = locate(source, selected.text, { syntax })
  if (found.kind === 'missing') {
    void $.ui.toast(`Couldn't find that text in ${file}. Try a selection within one block.`)

    return
  }
  if (found.kind === 'ambiguous') {
    void $.ui.toast(`That text appears ${found.count} times. Select a longer passage.`)

    return
  }

  const symbol = syntax === 'code' ? enclosingSymbol(source, found.anchor.lineStart) : undefined
  const anchor = symbol === undefined ? found.anchor : { ...found.anchor, symbol }
  if (!ASKS_NOTE.has(type)) return addAnnotation($, file, type, anchor)
  await update($, draftAtom, () => ({ type, anchor }))
  void $.ui.focus({ requestId: PANE, key: 'note' }).catch(() => undefined)
}

async function saveDraft($: EngineInterface, value: string): Promise<void> {
  const file = await read($, fileAtom)
  const draft = await read($, draftAtom)
  if (file === null || draft === null) return
  const note = value.trim()
  if (draft.type === 'comment' && note === '') {
    void $.ui.toast('A comment needs text.')

    return
  }
  await update($, draftAtom, () => null)
  await addAnnotation($, file, draft.type, draft.anchor, note)
}

async function addAnnotation(
  $: EngineInterface,
  file: string,
  type: AnnotationType,
  anchor: Anchor,
  comment = '',
): Promise<void> {
  const annotation: Annotation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    type,
    anchor,
    ...(comment === '' ? {} : { comment }),
    status: 'open',
    createdAt: new Date().toISOString(),
  }
  const next = await update($, annotationsAtom, list => [...list, annotation])
  await saveReview($, next)
}

async function dismiss($: EngineInterface, id: string): Promise<void> {
  const next = await update($, annotationsAtom, list =>
    list.map(one => (one.id === id ? { ...one, status: 'dismissed' as const } : one)),
  )
  await saveReview($, next)
}

async function sendReview($: EngineInterface, mode: SendMode): Promise<void> {
  if ((await read($, pendingAtom)) !== null) {
    void $.ui.toast('cotext: Claude is still on the last review.')

    return
  }
  const file = await read($, fileAtom)
  const scope = await read($, scopeAtom)
  const active = promptOrder(
    (await read($, annotationsAtom)).filter(
      one => isActive(one) && (scope === 'project' || one.file === file),
    ),
  )
  if (active.length === 0) {
    void $.ui.toast('No active annotations to send.')

    return
  }

  await update($, pendingAtom, () => ({ mode, ids: active.map(one => one.id) }))
  // Resolves as the turn starts, which waits for a running one to end.
  void $.prompt
    .submit({ text: buildReviewPrompt(active, mode), asUser: true })
    .catch(async () => {
      await update($, pendingAtom, () => null)
      void $.ui.toast('cotext: the review could not be sent.')
    })
  void $.ui.toast(
    `Sent ${active.length} annotation${active.length === 1 ? '' : 's'} to Claude (${mode}).`,
  )
}

async function loadReview($: EngineInterface): Promise<Annotation[]> {
  if (!(await $.fs.exists(REVIEW_PATH))) return []

  return parseReview(await $.fs.read(REVIEW_PATH))
}

async function saveReview($: EngineInterface, annotations: Annotation[]): Promise<void> {
  await $.fs.write(REVIEW_PATH, serializeReview(annotations))
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
