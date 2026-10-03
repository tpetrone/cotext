import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Anchor, Annotation, AnnotationType, Edit, SendMode } from '../types'
import { anchorAt, guessNear, isLive, lineOf, locate, relocate } from './anchor'
import { PROMPT_HEADER, RESOLVE_TOOL, buildReviewPrompt, promptOrder } from './review-prompt'
import { chunkLines, segment, segmentAt, syntaxOf } from './segments'
import type { Segment } from './segments'
import { lineBounds, moved } from './motion'
import { followRename, parseRenames } from './renames'
import { REVIEW_PATH, parseReview, serializeReview } from './store'
import { enclosingSymbol } from './symbols'

const PANE = 'cotext'
// How often an open pane looks for changes made to review.json outside it.
const POLL_MS = 1500
// How long the pane keeps the lines an outside edit touched marked.
const CHANGED_MS = 30_000
// How many places of an ambiguous selection the pane offers.
const MAX_CHOICES = 8
// What an edit from the pane replaced, newest last, for undo.
const UNDO_DEPTH = 50
const undoStack: { file: string; text: string }[] = []
// The module's own: a reload drops it, and session.start starts it again.
let polling: Timer | undefined

const fileAtom = atom({ plugin: 'cotext', key: 'file' } as const, null)
const sourceAtom = atom({ plugin: 'cotext', key: 'source' } as const, '')
const annotationsAtom = atom({ plugin: 'cotext', key: 'annotations' } as const, [])
const changedAtom = atom({ plugin: 'cotext', key: 'changed' } as const, null)
const missingAtom = atom({ plugin: 'cotext', key: 'missing' } as const, false)
const cursorAtom = atom({ plugin: 'cotext', key: 'cursor' } as const, null)
const visualAtom = atom({ plugin: 'cotext', key: 'visual' } as const, null)
const editAtom = atom({ plugin: 'cotext', key: 'edit' } as const, null)
const compactAtom = atom({ plugin: 'cotext', key: 'compact' } as const, null)
const viewAtom = atom({ plugin: 'cotext', key: 'view' } as const, 'text')
const diskAtom = atom({ plugin: 'cotext', key: 'disk' } as const, null)
const draftAtom = atom({ plugin: 'cotext', key: 'draft' } as const, null)
const pickAtom = atom({ plugin: 'cotext', key: 'pick' } as const, null)
const pendingAtom = atom({ plugin: 'cotext', key: 'pending' } as const, null)
const scopeAtom = atom({ plugin: 'cotext', key: 'scope' } as const, 'file')
const showResolvedAtom = atom({ plugin: 'cotext', key: 'showResolved' } as const, false)

type Mark = { type: AnnotationType; hotkey: string; label: string; tag: string; color: string }

// Digits, so the letters stay the cursor's (h j k l w b ...) as in vim.
type Move = { key: string; hotkey: string; label: string }

const MOVES: readonly Move[] = [
  { key: 'left', hotkey: 'h', label: '←' },
  { key: 'down', hotkey: 'j', label: '↓' },
  { key: 'up', hotkey: 'k', label: '↑' },
  { key: 'right', hotkey: 'l', label: '→' },
  { key: 'word', hotkey: 'w', label: 'word' },
  { key: 'back', hotkey: 'b', label: 'back' },
  { key: 'home', hotkey: '0', label: 'line start' },
  { key: 'tail', hotkey: 'e', label: 'line end' },
  { key: 'top', hotkey: 'g', label: 'top' },
  { key: 'bottom', hotkey: 't', label: 'bottom' },
]

// Letters and digits no command uses: taken, so a stray key stays in the pane.
const IDLE_KEYS = ['m', 'r', 'u', '7', '8', '9'] as const

const EDITS: readonly { kind: Edit['kind']; hotkey: string; label: string }[] = [
  { kind: 'insert', hotkey: 'i', label: 'insert' },
  { kind: 'append', hotkey: 'a', label: 'append' },
  { kind: 'open', hotkey: 'o', label: 'new line' },
  { kind: 'change', hotkey: 'c', label: 'change' },
]

const MARKS: readonly Mark[] = [
  { type: 'highlight', hotkey: '1', label: 'highlight', tag: 'H', color: 'magenta' },
  { type: 'question', hotkey: '2', label: 'question', tag: '?', color: 'yellow' },
  { type: 'reject', hotkey: '3', label: 'reject', tag: 'X', color: 'red' },
  { type: 'accept', hotkey: '4', label: 'accept', tag: 'A', color: 'green' },
  { type: 'investigate', hotkey: '5', label: 'investigate', tag: 'I', color: 'cyan' },
  { type: 'comment', hotkey: '6', label: 'comment', tag: 'C', color: 'blue' },
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
        'annotation, by its number in the review. Call it once, when done with the review. ' +
        'Outside a review, close an annotation by its id instead, once the user has decided ' +
        'what it asked; called with no items, it lists the annotations waiting on the user.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                n: { type: 'integer', description: 'The ANNOTATION number in the review.' },
                id: { type: 'string', description: "The annotation's id, in place of n." },
                status: { type: 'string', enum: ['resolved', 'needs_human'] },
                summary: {
                  type: 'string',
                  description: 'One line: what you did, or what the user has to decide.',
                },
              },
              required: ['status', 'summary'],
            },
          },
        },
        required: ['items'],
      },
    })
    if ((await read($, fileAtom)) !== null) startPolling($)

    return next(e)
  })

  on('command.run', { command: 'cotext' }, async ($, e) => {
    const path = e.args.trim().replace(/^@/, '').replace(/^["']|["']$/g, '').replace(/^\.\//, '')
    if (path === '') {
      const file = await read($, fileAtom)
      if (file === null) return { text: 'Usage: /cotext <file>' }
      startPolling($)
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
      await sync($)
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
    if (e.agentId !== undefined) return done
    // Any turn may have edited or moved an annotated file, a Bash sed or git mv among them.
    await sync($)
    const pending = await read($, pendingAtom)
    if (pending?.turnId !== e.turnId) return done

    await update($, pendingAtom, () => null)
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
    const editing = await read($, editAtom)
    const pick = await read($, pickAtom)
    const pending = await read($, pendingAtom)
    const scope = await read($, scopeAtom)
    const showResolved = await read($, showResolvedAtom)
    const changed = await read($, changedAtom)
    const missing = await read($, missingAtom)
    const cursor = await read($, cursorAtom)
    const visual = await read($, visualAtom)
    const view = await read($, viewAtom)
    const compactChoice = await read($, compactAtom)

    const isMarkdown = syntaxOf(file) === 'markdown'
    const segments = isMarkdown ? segment(source) : chunkLines(source)
    const high = cursor === null ? -1 : Math.max(cursor, visual ?? cursor)
    const low = cursor === null ? -1 : Math.min(cursor, visual ?? cursor)
    // The segment the cursor is in is drawn as the source, so the selection can show.
    const isUnderCursor = (one: Segment) =>
      cursor !== null && low <= one.end && high >= one.start
    const here = all.filter(one => one.file === file)
    const bySegment = new Map<number, Annotation[]>()
    for (const one of here.filter(isActive)) {
      if (one.detached !== undefined || !isLive(source, one.anchor)) continue
      const at = segmentAt(segments, one.anchor.end - 1)
      bySegment.set(at, [...(bySegment.get(at) ?? []), one])
    }

    const listed = scope === 'file' ? here : all
    const active = listed.filter(isActive).filter(one => one.detached === undefined)
    const stale = listed.filter(isActive).filter(one => one.detached !== undefined)
    const isChanged = (one: Segment) =>
      changed !== null &&
      one.line <= changed.lineEnd &&
      one.line + one.text.split('\n').length - 1 >= changed.lineStart
    const resolved = listed.filter(one => one.status === 'resolved')
    const files = [...new Set(listed.map(one => one.file))]
    const width = Math.max(20, e.props.bodyColumns - 14)
    const gutter = String(segments.at(-1)?.line ?? 1).length
    const where = scope === 'project' ? 'project' : file
    const suffix = scope === 'project' ? ' project' : ''

    const row = (one: Annotation) => {
      const mark = markOf(one.type)
      const gone =
        one.detached === 'file'
          ? 'file gone'
          : one.detached === 'text' || (one.file === file && !isLive(source, one.anchor))
            ? 'text changed'
            : undefined
      const symbol = one.anchor.symbol ? `${one.anchor.symbol}  ` : ''
      const label = `[${mark.tag}] L${one.anchor.lineStart}  ${symbol}${excerpt(one.comment ?? one.anchor.selectedText, width)}`

      return (
        <Box key={`row-${one.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button
              key={`go-${one.id}`}
              plain
              dimColor={gone !== undefined}
              onPress={() => goTo($, one)}
            >
              {gone === undefined ? label : `${label} (${gone})`}
            </Button>
            <Button key={`dismiss-${one.id}`} plain dimColor onPress={() => dismiss($, one.id)}>
              ×
            </Button>
          </Box>
          {one.detached === 'text' && (
            <Text color="yellow">
              {one.guess === undefined
                ? '    ↳ the passage was rewritten and no likely place was found'
                : `    ↳ approximate, now L${one.guess.lineStart}: ${excerpt(one.guess.text, width)}`}
            </Text>
          )}
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

    const columns = Math.max(20, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows
    const rowsFor = (labels: readonly string[]) => {
      let rows = 1
      let used = 0
      for (const label of labels) {
        if (used > 0 && used + label.length + 1 > columns) {
          rows++
          used = 0
        }
        used += label.length + 1
      }

      return rows
    }
    // Short panes get only the keys, so the text keeps its rows; q flips it by hand.
    const compact = compactChoice ?? bodyRows < 28
    // r and u are taken by their own buttons while those show.
    const idleKeys = IDLE_KEYS.filter(
      key => !(key === 'r' && resolved.length > 0) && !(key === 'u' && changed !== null && !missing),
    )
    // A plain Button draws "k: label", so each costs three cells more than its label.
    const moveLabels = [...MOVES.map(one => one.label), 'next note', 'leave visual', 'notes'].map(one => `k: ${one}`)
    const editLabels = [...EDITS.map(one => one.label), 'delete', 'line', 'undo'].map(one => `k: ${one}`)
    const markLabels = MARKS.map(one => `k: ${one.label}`)
    const sendLabels = ['Review project', 'Apply project', 'f project', 'q compact', ...idleKeys.map(() => 'k: ·')]
    // What the header takes, counted generously: a body too tall would scroll it away.
    const headerRows =
      1 +
      (e.viewport?.isFullscreen === false ? 1 : 0) +
      (compact
        ? rowsFor([...moveLabels, ...editLabels, ...markLabels, ...sendLabels])
        : rowsFor(moveLabels) + rowsFor(editLabels) + rowsFor(markLabels) + rowsFor(sendLabels)) +
      1 +
      (missing ? 2 : 0) +
      (changed !== null ? 1 : 0) +
      (pending !== null ? 1 : 0) +
      (pick === null ? 0 : 2 + Math.min(pick.anchors.length, MAX_CHOICES)) +
      (editing !== null ? 1 : 0) +
      (draft !== null ? 2 : 0)
    const avail = Math.max(4, bodyRows - headerRows - 1)

    // Each segment's rows as drawn, near enough to centre the cursor's.
    const heightOf = (one: Segment, i: number) =>
      one.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length + gutter + 1) / columns)), 0) +
      (isMarkdown ? 1 : 0) +
      (isChanged(one) ? 1 : 0) +
      (bySegment.get(i)?.length ?? 0)
    const heights = segments.map(heightOf)
    const focusAt = cursor === null ? 0 : segmentAt(segments, Math.min(cursor, Math.max(0, source.length - 1)))
    let top = focusAt
    for (let room = Math.floor((avail - (heights[focusAt] ?? 1)) / 2); top > 0 && room >= (heights[top - 1] ?? 1); ) {
      top--
      room -= heights[top] ?? 1
    }
    if (cursor === null) top = 0

    const moveButtons = [
      ...MOVES.map(move => (
        <Button key={move.key} hotkey={move.hotkey} plain dimColor onPress={() => moveCursor($, move.key)}>
          {move.label}
        </Button>
      )),
      <Button key="next" hotkey="n" plain dimColor onPress={() => moveToNote($)}>
        {'next note'}
      </Button>,
      <Button key="visual" hotkey="v" plain onPress={() => toggleVisual($)}>
        {visual === null ? 'visual' : 'leave visual'}
      </Button>,
      <Button key="notes" hotkey="y" plain dimColor onPress={() => update($, viewAtom, value => (value === 'text' ? 'notes' : 'text'))}>
        {view === 'text' ? 'notes' : 'text'}
      </Button>,
    ]
    const editButtons = [
      ...EDITS.map(one => (
        <Button key={`edit-${one.kind}`} hotkey={one.hotkey} plain dimColor onPress={() => startEdit($, one.kind)}>
          {one.label}
        </Button>
      )),
      <Button key="delete-char" hotkey="x" plain dimColor onPress={() => remove($, false)}>
        {'delete'}
      </Button>,
      <Button key="delete-line" hotkey="d" plain dimColor onPress={() => remove($, true)}>
        {'line'}
      </Button>,
      <Button key="undo" hotkey="z" plain dimColor onPress={() => undoEdit($)}>
        {'undo'}
      </Button>,
    ]
    const markButtons = MARKS.map(mark => (
      <Button key={mark.type} hotkey={mark.hotkey} plain onPress={() => startMark($, mark.type)}>
        {mark.label}
      </Button>
    ))
    const sendButtons = [
      <Button key="send-review" hotkey="s" {...(compact ? { plain: true as const } : { variant: 'primary' as const })} onPress={() => sendReview($, 'review')}>
        {`Review${suffix}`}
      </Button>,
      <Button key="send-apply" hotkey="p" {...(compact ? { plain: true as const } : {})} onPress={() => sendReview($, 'apply')}>
        {`Apply${suffix}`}
      </Button>,
      <Button key="scope" hotkey="f" plain dimColor onPress={() => update($, scopeAtom, value => (value === 'file' ? 'project' : 'file'))}>
        {scope === 'file' ? 'this file' : 'project'}
      </Button>,
      <Button key="compact" hotkey="q" plain dimColor onPress={() => update($, compactAtom, () => !compact)}>
        {'compact'}
      </Button>,
      // Keys with no command are taken here, so they do not fall through to the chat.
      ...idleKeys.map(key => (
        <Button key={`idle-${key}`} hotkey={key} plain dimColor onPress={() => undefined}>
          ·
        </Button>
      )),
    ]

    const header = (
      <Box flexDirection="column">
        {e.viewport?.isFullscreen === false && (
          <Text color="yellow">Selecting text needs the fullscreen terminal.</Text>
        )}
        <Text bold color={editing !== null ? 'green' : visual === null ? 'cyan' : 'magenta'}>
          {editing !== null
            ? '-- INSERT --'
            : visual === null
              ? '-- NORMAL --'
              : `-- VISUAL -- ${high - low + 1} chars`}
          <Text dimColor>
            {'  '}
            {where} · {active.length} active
            {stale.length > 0 ? ` · ${stale.length} changed` : ''} · ctrl+x tab: here · esc: chat
          </Text>
        </Text>
        {compact ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {moveButtons}
            {editButtons}
            {markButtons}
            {sendButtons}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{moveButtons}</Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{editButtons}</Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{markButtons}</Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{sendButtons}</Box>
          </Box>
        )}

        {missing && (
          <Text color="red">
            {`${file} is gone from disk and no rename was found; the text below is the last seen, not current.`}
          </Text>
        )}
        {changed !== null && !missing && (
          <Box flexDirection="row" columnGap={1}>
            <Text color="green">{`updated now · L${changed.lineStart}${changed.lineEnd > changed.lineStart ? `–${changed.lineEnd}` : ''}`}</Text>
            <Button key="changed-go" hotkey="u" plain onPress={() => goToChange($)}>
              u show
            </Button>
            <Button key="changed-clear" plain dimColor onPress={() => update($, changedAtom, () => null)}>
              ×
            </Button>
          </Box>
        )}

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

        {pick !== null && (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color={markOf(pick.type).color}>
                {`That text appears ${pick.anchors.length} times. Which one?`}
              </Text>
              <Button key="pick-cancel" plain dimColor onPress={() => update($, pickAtom, () => null)}>
                cancel
              </Button>
            </Box>
            {pick.anchors.slice(0, MAX_CHOICES).map((anchor, i) => (
              <Button key={`pick-${i}`} plain onPress={() => choose($, anchor)}>
                {`L${anchor.lineStart}  ${excerpt(around(anchor), width)}`}
              </Button>
            ))}
            {pick.anchors.length > MAX_CHOICES && (
              <Text dimColor>
                {`${pick.anchors.length - MAX_CHOICES} more: select a longer passage to narrow it.`}
              </Text>
            )}
          </Box>
        )}

        {editing !== null && (
          <Box flexDirection="row" columnGap={1}>
            <Input
              key="edit"
              label={editing.kind === 'change' ? 'change ' : editing.kind === 'open' ? 'new line ' : 'insert '}
              value={editing.value}
              submitLabel="done"
              autoFocus
              onInput={value => applyEdit($, value)}
              onSubmit={value => commitEdit($, value)}
            />
            <Button key="edit-cancel" plain dimColor onPress={() => revertEdit($)}>
              revert
            </Button>
          </Box>
        )}

        {draft !== null && (
          <Box flexDirection="column">
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
      </Box>
    )

    const notes = (
      <Box flexDirection="column">
        {group(active.filter(one => one.status === 'needs_human'))}
        {group(active.filter(one => one.status === 'open'))}
        {stale.length > 0 && <Text color="yellow">TEXT CHANGED OR FILE GONE · {stale.length}</Text>}
        {group(stale)}
        {resolved.length > 0 && (
          <Button
            key="resolved"
            hotkey="r"
            plain
            dimColor
            onPress={() => update($, showResolvedAtom, value => !value)}
          >
            {`r ${resolved.length} resolved ${showResolved ? '▾' : '▸'}`}
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
    )

    // The body is a window of exactly `avail` rows that the cursor moves, so the header stays put.
    const text = (
      <Box flexDirection="column" flexShrink={0}>
        {segments.slice(top).map((one, n) => {
          const i = top + n

          return (
            <Box key={`seg-${i}`} flexDirection="column" flexShrink={0} marginBottom={isMarkdown ? 1 : 0}>
              {isChanged(one) && <Text color="green">{'  ▌ updated'}</Text>}
              {isUnderCursor(one) ? (
                <Box flexDirection="column">
                  {cursorLines(one, low, high).map((part, line) => (
                    <Text key={`cur-${line}`}>
                      {part.before}
                      <Text inverse color={visual === null ? 'cyan' : 'magenta'}>
                        {part.inside}
                      </Text>
                      {part.after}
                    </Text>
                  ))}
                </Box>
              ) : isMarkdown ? (
                <Box flexDirection="row" columnGap={1}>
                  <Text dimColor>{String(one.line).padStart(gutter)}</Text>
                  <Box flexDirection="column" flexGrow={1}>
                    <Markdown text={one.text} />
                  </Box>
                </Box>
              ) : (
                <Code source={one.text} path={file} startLine={one.line} />
              )}
              {(bySegment.get(i) ?? []).map(mark => (
                <Text key={`mark-${mark.id}`} color={markOf(mark.type).color}>
                  {'  ^ '}
                  {markOf(mark.type).tag} {excerpt(mark.comment ?? mark.anchor.selectedText, width)}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" height={avail} overflow="hidden" flexShrink={0} marginTop={1}>
          {view === 'text' ? text : notes}
        </Box>
      </Box>
    )
  })
}

/**
 * Records what Claude reports for each annotation: by its number in the
 * review in flight, or by its id at any time, so a decision the user makes
 * after a review can still close what was handed back.
 */
async function resolveAnnotations($: EngineInterface, input: unknown): Promise<string> {
  const pending = await read($, pendingAtom)
  const items = (input as { items?: unknown }).items
  const entries: unknown[] = Array.isArray(items) ? items : []
  const unreadable = await pull($)
  if (unreadable !== undefined) return `cotext: ${unreadable} Nothing was recorded.`
  const known = await read($, annotationsAtom)
  const active = new Set(known.filter(isActive).map(one => one.id))
  const at = new Date().toISOString()
  const changes = new Map<string, { status: 'resolved' | 'needs_human'; summary: string }>()
  const unknown: unknown[] = []
  for (const item of entries) {
    const { n, id, status, summary } = (item ?? {}) as Record<string, unknown>
    const target =
      typeof id === 'string' ? id : typeof n === 'number' ? pending?.ids[n - 1] : undefined
    if (target === undefined || !active.has(target) || (status !== 'resolved' && status !== 'needs_human')) {
      unknown.push(id ?? n)
      continue
    }
    changes.set(target, { status, summary: typeof summary === 'string' ? summary : '' })
  }

  if (changes.size > 0) {
    await edit($, list =>
      list.map(one => {
        const change = changes.get(one.id)

        return change === undefined
          ? one
          : { ...one, status: change.status, resolution: { summary: change.summary, at } }
      }),
    )
  }

  const notRecognised = unknown.length > 0 ? [`Not recognised: ${unknown.map(String).join(', ')}.`] : []
  if (pending === null) {
    if (changes.size > 0) return [`Recorded ${count(changes.size)}.`, ...notRecognised].join(' ')

    return [...notRecognised, waitingOnUser(known)].join(' ')
  }

  const missing = pending.ids.filter(id => !changes.has(id)).length
  const notes = [
    `Recorded ${changes.size} of ${count(pending.ids.length)}.`,
    ...notRecognised,
    ...(missing > 0 ? [`${missing} annotations have no entry yet.`] : []),
  ]

  return notes.join(' ')
}

/** What the tool answers outside a review: the decisions handed back, by id. */
function waitingOnUser(annotations: readonly Annotation[]): string {
  const waiting = annotations.filter(one => one.status === 'needs_human')
  if (waiting.length === 0) return 'No cotext review is open and no annotation waits on the user.'
  const lines = waiting.map(one => {
    const gone = one.detached ? ` (${one.detached === 'text' ? 'text changed' : 'file gone'})` : ''
    const said = one.resolution?.summary ?? one.comment ?? one.anchor.selectedText

    return `- id ${one.id}: ${one.file} L${one.anchor.lineStart}${gone}: ${said}`
  })

  return [
    'No cotext review is open. These annotations wait on the user; once the user has decided, ' +
      'close each with `{ id, status, summary }`:',
    ...lines,
  ].join('\n')
}

/**
 * Reads `path` into the pane with its annotations re-anchored, and opens the
 * pane. Answers how many annotations are active there, or why it could not.
 */
async function openFile($: EngineInterface, path: string): Promise<number | string> {
  if (!(await $.fs.exists(path))) return `No such file: ${path}`
  let source: string
  try {
    source = await $.fs.read(path)
  } catch (error) {
    return `cotext: ${error instanceof Error ? error.message : String(error)}`
  }
  const unreadable = await pull($)
  if (unreadable !== undefined) return `cotext: ${unreadable}`

  const placed = await reconcile($, await read($, annotationsAtom))
  await edit($, () => placed)
  await update($, fileAtom, () => path)
  await update($, sourceAtom, () => source)
  await update($, draftAtom, () => null)
  await update($, pickAtom, () => null)
  await update($, changedAtom, () => null)
  await update($, missingAtom, () => false)
  await update($, cursorAtom, () => null)
  await update($, visualAtom, () => null)
  startPolling($)
  await $.ui.open({ id: PANE, title: `cotext · ${path}`, focus: true })

  return (await read($, annotationsAtom)).filter(one => one.file === path && isActive(one)).length
}

/**
 * Places every annotation against the files as they are now and saves what
 * moved. The pane follows its file when git saw it renamed, shows the new
 * text and marks what changed; a file gone with no rename is flagged, not
 * kept on screen as current.
 */
async function sync($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  if ((await pull($)) !== undefined) return
  const before = await read($, annotationsAtom)
  const after = await reconcile($, before)
  await edit($, () => after)

  const movedTo = after.find((one, i) => before[i]!.file === file && one.file !== file)?.file
  let open = movedTo
  if (open === undefined && !(await $.fs.exists(file))) {
    const to = followRename(await gitRenames($), file)
    if (to !== file && (await $.fs.exists(to))) open = to
  }
  open ??= file
  if (!(await $.fs.exists(open))) {
    if (!(await read($, missingAtom))) await update($, missingAtom, () => true)

    return
  }
  if (await read($, missingAtom)) await update($, missingAtom, () => false)
  const source = await $.fs.read(open)
  const was = await read($, sourceAtom)
  if (open !== file) {
    await update($, fileAtom, () => open)
    void $.ui.toast(`cotext: ${file} moved to ${open}.`)
  }
  if (source === was) return

  // The marked lines are the new text's, between what both versions share.
  const changed = changedLines(was, source)
  await update($, sourceAtom, () => source)
  const clamp = (at: number | null) => (at === null ? null : Math.min(at, Math.max(0, source.length - 1)))
  await update($, cursorAtom, clamp)
  await update($, visualAtom, clamp)
  await update($, changedAtom, () => (changed === null ? null : { ...changed, at: Date.now() }))
  await edit($, list => reanchor(list, open, source))
}

/** The lines of `now` that differ from `was`, found by the text both keep at either end. */
function changedLines(was: string, now: string): { lineStart: number; lineEnd: number } | null {
  if (was === now) return null
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head]) head++
  let tail = 0
  while (
    tail < was.length - head &&
    tail < now.length - head &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail++
  }
  const end = Math.max(head, now.length - tail)

  return { lineStart: lineOf(now, head), lineEnd: lineOf(now, Math.max(head, end - 1)) }
}

/**
 * Every active annotation where its file is now: a file git saw renamed
 * takes its new path, one gone with no rename found is detached, and one
 * still there is re-anchored against its text.
 */
async function reconcile($: EngineInterface, annotations: Annotation[]): Promise<Annotation[]> {
  const sources = new Map<string, string | null>()
  const sourceOf = async (path: string): Promise<string | null> => {
    if (!sources.has(path)) sources.set(path, (await $.fs.exists(path)) ? await $.fs.read(path) : null)

    return sources.get(path)!
  }
  let renames: Map<string, string> | undefined

  const placed: Annotation[] = []
  for (const one of annotations) {
    if (!isActive(one)) {
      placed.push(one)
      continue
    }
    let file = one.file
    if ((await sourceOf(file)) === null) {
      renames ??= await gitRenames($)
      const to = followRename(renames, file)
      if (to !== file && (await sourceOf(to)) !== null) file = to
    }
    const source = await sourceOf(file)
    if (source === null) {
      placed.push(one.detached === 'file' ? one : { ...one, detached: 'file' })
      continue
    }
    placed.push(reanchor([file === one.file ? one : { ...one, file }], file, source)[0]!)
  }

  return placed
}

/** The renames git saw, committed lately or in the working tree, from old path to new. */
async function gitRenames($: EngineInterface): Promise<Map<string, string>> {
  const renames = new Map<string, string>()
  try {
    const log = await $.process.run(
      ['git', 'log', '-n', '200', '--format=', '--name-status', '-M', '--diff-filter=R', '--relative', '-z'],
    )
    const work = await $.process.run(['git', 'diff', 'HEAD', '--name-status', '-M', '--relative', '-z'])
    // Oldest first, so a later rename of a path wins.
    const pairs = [
      ...(log.exitCode === 0 ? parseRenames(log.stdout).reverse() : []),
      ...(work.exitCode === 0 ? parseRenames(work.stdout) : []),
    ]
    for (const [from, to] of pairs) renames.set(from, to)
  } catch {
    // Not a git repository, or git is missing: no renames to follow.
  }

  return renames
}

// Offsets go stale when the file changes, between reviews or under an edit.
function reanchor(annotations: Annotation[], file: string, source: string): Annotation[] {
  const syntax = syntaxOf(file)

  return annotations.map(one => {
    if (one.file !== file || !isActive(one)) return one
    const anchor = relocate(source, one.anchor, syntax)
    if (anchor === null) {
      const guess = guessNear(source, one.anchor) ?? undefined
      const same = one.detached === 'text' && JSON.stringify(one.guess) === JSON.stringify(guess)
      if (same) return one
      const { guess: _, ...rest } = one

      return { ...rest, detached: 'text', ...(guess === undefined ? {} : { guess }) }
    }
    if (anchor === one.anchor && one.detached === undefined) return one
    const { detached: _, guess: __, ...placed } = one

    return { ...placed, anchor }
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
  const at = isLive(source, current.anchor) ? current.anchor.start : current.guess?.start
  if (at === undefined) {
    return void $.ui.toast('This annotation lost its place in the file.')
  }
  const segments: Segment[] = syntaxOf(one.file) === 'markdown' ? segment(source) : chunkLines(source)
  await $.ui.scroll({
    in: PANE,
    to: { key: `seg-${segmentAt(segments, at)}` },
    block: 'start',
  })
}

async function goToChange($: EngineInterface): Promise<void> {
  const changed = await read($, changedAtom)
  const file = await read($, fileAtom)
  if (changed === null || file === null) return
  const source = await read($, sourceAtom)
  const segments: Segment[] = syntaxOf(file) === 'markdown' ? segment(source) : chunkLines(source)
  const first = segments.findIndex(one => one.line + one.text.split('\n').length - 1 >= changed.lineStart)
  await $.ui.scroll({ in: PANE, to: { key: `seg-${Math.max(0, first)}` }, block: 'start' }).catch(() => undefined)
}

async function startMark($: EngineInterface, type: AnnotationType): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const source = await read($, sourceAtom)
  const syntax = syntaxOf(file)

  // The keyboard's selection wins over the mouse's: the visual range, else the cursor's line.
  const cursor = await read($, cursorAtom)
  const visual = await read($, visualAtom)
  const selected = cursor === null ? await $.ui.selection() : undefined
  if (cursor !== null || selected === undefined || selected.text.trim() === '') {
    if (cursor === null) return void $.ui.toast('Press j/k to place the cursor, or select with the mouse.')
    let start = visual === null ? lineBounds(source, cursor).start : Math.min(cursor, visual)
    let end = visual === null ? lineBounds(source, cursor).end : Math.max(cursor, visual) + 1
    while (start < end && /\s/.test(source[start]!)) start++
    while (end > start && /\s/.test(source[end - 1]!)) end--
    if (end <= start) return void $.ui.toast('Nothing to mark here.')
    await update($, visualAtom, () => null)
    await update($, draftAtom, () => null)
    await update($, pickAtom, () => null)

    return place($, file, type, anchorAt(source, { start, end }))
  }

  const found = locate(source, selected.text, { syntax })
  if (found.kind === 'missing') {
    void $.ui.toast(`Couldn't find that text in ${file}. Try a selection within one block.`)

    return
  }
  await update($, draftAtom, () => null)
  if (found.kind === 'ambiguous') {
    // The host does not say where in the file the selection was: the user does.
    await update($, pickAtom, () => ({ type, anchors: found.anchors }))

    return
  }
  await update($, pickAtom, () => null)

  return place($, file, type, found.anchor)
}

/**
 * Rewrites the open file from what is on disk now, as `make` says, and
 * follows it: annotations re-anchor and the change is marked. Refuses when the
 * pane's copy is stale, so offsets taken from it never land in other text.
 */
async function rewrite(
  $: EngineInterface,
  make: (source: string) => { text: string; cursor: number } | string,
): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  if (!(await $.fs.exists(file))) return void $.ui.toast(`cotext: ${file} is gone.`)
  const current = await $.fs.read(file)
  if (current !== (await read($, sourceAtom))) {
    await sync($)

    return void $.ui.toast('cotext: the file changed meanwhile; look and edit again.')
  }
  const made = make(current)
  if (typeof made === 'string') return void $.ui.toast(made)
  if (made.text === current) return

  try {
    await $.fs.write(file, made.text)
  } catch (error) {
    return void $.ui.toast(`cotext: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  undoStack.push({ file, text: current })
  if (undoStack.length > UNDO_DEPTH) undoStack.shift()
  void $.ui.toast(`cotext: wrote ${file}.`)
  await sync($)
  await update($, visualAtom, () => null)
  await update($, cursorAtom, () => Math.max(0, Math.min(made.cursor, made.text.length - 1)))
  await scrollToOffset($, file, made.text, Math.max(0, Math.min(made.cursor, made.text.length - 1)))
}

/**
 * Opens the Input that `kind` of edit types into: the cursor's line (or the one-line
 * selection) held whole, so typing and deleting land in the file as they happen.
 */
async function startEdit($: EngineInterface, kind: Edit['kind']): Promise<void> {
  const source = await read($, sourceAtom)
  const file = await read($, fileAtom)
  const cursor = await read($, cursorAtom)
  if (file === null || cursor === null) return void $.ui.toast('Press j/k to place the cursor first.')
  const visual = await read($, visualAtom)
  const line = lineBounds(source, cursor)
  let start = line.start
  let end = line.end
  let prefix = ''
  if (kind === 'open') {
    start = end = line.end
    prefix = '\n'
  } else if (visual !== null) {
    start = Math.min(cursor, visual)
    end = Math.max(cursor, visual) + 1
  }
  const original = source.slice(start, end)
  if (original.includes('\n')) return void $.ui.toast('cotext: insert takes one line; use d to delete several.')
  await update($, visualAtom, () => null)
  await update($, draftAtom, () => null)
  await update($, pickAtom, () => null)
  // One undo step for the whole edit, taken before the first keystroke lands.
  undoStack.push({ file, text: source })
  if (undoStack.length > UNDO_DEPTH) undoStack.shift()
  await update($, editAtom, () => ({ kind, start, end, value: original, original, prefix }))
  if (kind === 'open') await applyEdit($, '')
  void $.ui.focus({ requestId: PANE, key: 'edit' }).catch(() => undefined)
}

/** Writes what the Input holds over the edit's span of the file, as it is typed. */
async function applyEdit($: EngineInterface, value: string, prefix?: string): Promise<void> {
  const typing = await read($, editAtom)
  const file = await read($, fileAtom)
  if (typing === null || file === null) return
  const lead = prefix ?? typing.prefix
  const current = (await $.fs.exists(file)) ? await $.fs.read(file) : null
  if (current === null || current !== (await read($, sourceAtom))) {
    await update($, editAtom, () => null)
    await sync($)

    return void $.ui.toast('cotext: the file changed meanwhile; look and edit again.')
  }
  const text = current.slice(0, typing.start) + lead + value + current.slice(typing.end)
  if (text !== current) {
    try {
      await $.fs.write(file, text)
    } catch (error) {
      return void $.ui.toast(`cotext: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const end = typing.start + lead.length + value.length
  await update($, editAtom, () => ({ ...typing, value, end, prefix: lead }))
  await sync($)
  const at = Math.max(0, Math.min(Math.max(typing.start, end - 1), text.length - 1))
  await update($, cursorAtom, () => at)
  await scrollToOffset($, file, text, at)
}

/** Enter: the text is already in the file, so this only leaves insert mode. */
async function commitEdit($: EngineInterface, text: string): Promise<void> {
  const typing = await read($, editAtom)
  if (typing === null) return
  if (text !== typing.value) await applyEdit($, text)
  await update($, editAtom, () => null)
  // An edit that changed nothing leaves nothing to undo.
  const file = await read($, fileAtom)
  const last = undoStack.at(-1)
  if (last !== undefined && last.file === file && last.text === (await read($, sourceAtom))) undoStack.pop()
}

/** Puts the span back as it was when insert mode opened, and leaves it. */
async function revertEdit($: EngineInterface): Promise<void> {
  const typing = await read($, editAtom)
  if (typing === null) return
  await applyEdit($, typing.original, '')
  await update($, editAtom, () => null)
  undoStack.pop()
}

/** Deletes the selection, or the character under the cursor, or with `whole` its line. */
async function remove($: EngineInterface, whole: boolean): Promise<void> {
  const cursor = await read($, cursorAtom)
  if (cursor === null) return void $.ui.toast('Press j/k to place the cursor first.')
  const visual = await read($, visualAtom)
  await rewrite($, source => {
    let start = Math.min(cursor, visual ?? cursor)
    let end = Math.max(cursor, visual ?? cursor) + 1
    if (visual === null && whole) {
      const line = lineBounds(source, cursor)
      start = line.start
      end = line.end + 1
      // The last line has no newline after it: take the one before.
      if (line.end >= source.length && start > 0) {
        start--
        end = source.length
      }
    } else if (visual === null && source[cursor] === '\n') {
      return 'cotext: nothing to delete here.'
    }

    return { text: source.slice(0, start) + source.slice(end), cursor: start }
  })
}

async function undoEdit($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  const last = undoStack.at(-1)
  if (last === undefined || last.file !== file) return void $.ui.toast('cotext: nothing to undo.')
  undoStack.pop()
  const depth = undoStack.length
  const cursor = (await read($, cursorAtom)) ?? 0
  await rewrite($, () => ({ text: last.text, cursor }))
  // The restore is not itself something to undo.
  undoStack.length = depth
}

/** Moves the keyboard cursor (the first key only places it) and keeps it in view. */
async function moveCursor($: EngineInterface, motion: string): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const source = await read($, sourceAtom)
  if (source === '') return
  const cursor = await read($, cursorAtom)
  const to = cursor === null ? Math.max(0, source.search(/\S/)) : moved(source, cursor, motion)
  await update($, cursorAtom, () => to)
  await scrollToOffset($, file, source, to)
}

async function toggleVisual($: EngineInterface): Promise<void> {
  const cursor = await read($, cursorAtom)
  if (cursor === null) return void $.ui.toast('Press j/k to place the cursor first.')
  await update($, visualAtom, value => (value === null ? cursor : null))
}

/** Puts the cursor on the next active annotation after it, wrapping round. */
async function moveToNote($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const source = await read($, sourceAtom)
  const starts = (await read($, annotationsAtom))
    .filter(one => one.file === file && isActive(one) && one.detached === undefined && isLive(source, one.anchor))
    .map(one => one.anchor.start)
    .sort((a, b) => a - b)
  if (starts.length === 0) return void $.ui.toast('No active annotations in this file.')
  const cursor = (await read($, cursorAtom)) ?? -1
  const next = starts.find(start => start > cursor) ?? starts[0]!
  await update($, cursorAtom, () => next)
  await scrollToOffset($, file, source, next)
}

async function scrollToOffset($: EngineInterface, file: string, source: string, offset: number): Promise<void> {
  const segments: Segment[] = syntaxOf(file) === 'markdown' ? segment(source) : chunkLines(source)
  await $.ui.scroll({ in: PANE, to: { key: `seg-${segmentAt(segments, offset)}` }, block: 'nearest' }).catch(() => undefined)
}

/** Marks `anchor` as `type`: at once, or once the user has typed the note it asks for. */
async function place($: EngineInterface, file: string, type: AnnotationType, found: Anchor): Promise<void> {
  const symbol =
    syntaxOf(file) === 'code' ? enclosingSymbol(await read($, sourceAtom), found.lineStart) : undefined
  const anchor = symbol === undefined ? found : { ...found, symbol }
  if (!ASKS_NOTE.has(type)) return addAnnotation($, file, type, anchor)
  await update($, draftAtom, () => ({ type, anchor }))
  void $.ui.focus({ requestId: PANE, key: 'note' }).catch(() => undefined)
}

async function choose($: EngineInterface, anchor: Anchor): Promise<void> {
  const file = await read($, fileAtom)
  const pick = await read($, pickAtom)
  if (file === null || pick === null) return
  await update($, pickAtom, () => null)
  await place($, file, pick.type, anchor)
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
  await edit($, list => [...list, annotation])
}

async function dismiss($: EngineInterface, id: string): Promise<void> {
  await edit($, list =>
    list.map(one => (one.id === id ? { ...one, status: 'dismissed' as const } : one)),
  )
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

/** One look at what may have changed outside the pane: review.json, the open file, the mark. */
async function tick($: EngineInterface): Promise<void> {
  await pull($)
  await sync($)
  const changed = await read($, changedAtom)
  if (changed !== null && Date.now() - changed.at > CHANGED_MS) await update($, changedAtom, () => null)
}

/** Watches review.json and the open file for changes made outside the pane, once per load of the module. */
function startPolling($: EngineInterface): void {
  polling ??= $.clock.every(POLL_MS, () => void tick($))
}

/**
 * Takes review.json into the pane when something other than the pane changed
 * it since the pane last read or wrote it, so the file is always the base a
 * change starts from. Answers why it could not, when review.json does not
 * parse; the pane then keeps what it had and writes nothing over the file.
 */
async function pull($: EngineInterface): Promise<string | undefined> {
  const text = (await $.fs.exists(REVIEW_PATH)) ? await $.fs.read(REVIEW_PATH) : ''
  const disk = await read($, diskAtom)
  const unreadable = `${REVIEW_PATH} does not parse; fix it and the pane picks it up again.`
  if (disk !== null && text === disk.text) return disk.isValid ? undefined : unreadable

  let annotations: Annotation[]
  try {
    annotations = text === '' ? [] : parseReview(text)
  } catch (error) {
    await update($, diskAtom, () => ({ text, isValid: false }))
    void $.ui.toast(`cotext: ${error instanceof Error ? error.message : String(error)}`)

    return unreadable
  }
  await update($, annotationsAtom, () => annotations)
  await update($, diskAtom, () => ({ text, isValid: true }))

  return undefined
}

/**
 * Changes the annotations from review.json as it is now and writes them back
 * when the change touched one. Answers whether review.json holds the change.
 */
async function edit($: EngineInterface, change: (list: Annotation[]) => Annotation[]): Promise<boolean> {
  const unreadable = await pull($)
  if (unreadable !== undefined) {
    void $.ui.toast(`cotext: ${unreadable}`)

    return false
  }
  const before = await read($, annotationsAtom)
  const after = await update($, annotationsAtom, change)
  if (after.length === before.length && after.every((one, i) => one === before[i])) return true

  const text = serializeReview(after)
  await $.fs.write(REVIEW_PATH, text)
  await update($, diskAtom, () => ({ text, isValid: true }))

  return true
}

/**
 * A segment's lines split around the selection `low`..`high` (inclusive
 * offsets in the file): each line carries its own highlighted part, since a
 * style does not carry across a newline. A selected empty line shows a blank cell.
 */
function cursorLines(one: Segment, low: number, high: number): { before: string; inside: string; after: string }[] {
  let offset = one.start

  return one.text.split('\n').map(line => {
    const from = Math.max(0, low - offset)
    const to = Math.min(line.length, high + 1 - offset)
    const selected = low <= offset + line.length && high >= offset
    const part =
      !selected
        ? { before: line, inside: '', after: '' }
        : from >= to
          ? { before: line.slice(0, from), inside: ' ', after: line.slice(from) }
          : { before: line.slice(0, from), inside: line.slice(from, to), after: line.slice(to) }
    offset += line.length + 1

    return part
  })
}

/** The text around an anchor, the passage in the middle, so places of the same words read apart. */
function around(anchor: Anchor): string {
  return `${anchor.contextBefore.slice(-24)}[${anchor.selectedText}]${anchor.contextAfter.slice(0, 24)}`
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function count(n: number): string {
  return n === 1 ? '1 annotation' : `${n} annotations`
}
