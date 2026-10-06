import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Accepted, Hunk, Message, Mode, RoundEdit, Server, Step, Thread } from '../types'
import { locate } from './anchor'
import type { Located } from './anchor'
import {
  acceptHunks,
  applyEdit,
  baseToDisplay,
  baseToWorking,
  display,
  displayToBase,
  displayToWorking,
  randomId,
  working,
} from './draft'
import {
  acceptedOf,
  appendArchive,
  archivePath,
  discarded,
  dropUnsaved,
  hasApplied,
  journalPath,
  parseJournal,
  restoreThreads,
  serializeJournal,
} from './journal'
import type { Journal } from './journal'
import {
  REVISER,
  REVISER_PROMPT,
  REVISER_TOOLS,
  REVISER_TYPE,
  buildAsk,
  findEdit,
  lastAsked,
  parseProposal,
} from './reviser'
import type { Proposal } from './reviser'
import { chunkLines, segment, syntaxOf } from './segments'
import type { Segment } from './segments'
import { enclosingSymbol } from './symbols'

const PANE = 'cotext'
// How often the mod looks at the open file on disk and the page's queue.
const POLL_MS = 1500
// How many steps Desfazer can take back.
const MAX_HISTORY = 200
// How much of the text around an edit a round keeps to find it again.
const EDIT_CONTEXT = 40

const MODES: readonly Mode[] = ['ask', 'comment']

// The tools whose edits to the open file the draft follows at once, and the path argument each edits.
const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

// The module's own: a reload drops them, and session.start starts them again.
let polling: Timer | undefined
let serving: Promise<Server | undefined> | undefined
let hasOpenedBrowser = false
let draining: Promise<void> = Promise.resolve()
let posting: Promise<void> = Promise.resolve()
let shownView = ''
let viewVersion = 0
// The journal as last written, so an unchanged one is not written again.
let writtenJournal = ''

const fileAtom = atom({ plugin: 'cotext', key: 'file' } as const, null)
const baseAtom = atom({ plugin: 'cotext', key: 'base' } as const, '')
const hunksAtom = atom({ plugin: 'cotext', key: 'hunks' } as const, [])
const pastAtom = atom({ plugin: 'cotext', key: 'past' } as const, [])
const futureAtom = atom({ plugin: 'cotext', key: 'future' } as const, [])
const threadsAtom = atom({ plugin: 'cotext', key: 'threads' } as const, [])
const acceptedAtom = atom({ plugin: 'cotext', key: 'accepted' } as const, [])
const staleAtom = atom({ plugin: 'cotext', key: 'stale' } as const, false)
const missingAtom = atom({ plugin: 'cotext', key: 'missing' } as const, false)
const serverAtom = atom({ plugin: 'cotext', key: 'server' } as const, null)

/** A passage the person selected on the page: its text, the block it began in, and the text around it. */
type Selection = { text: string; seg: number; contextBefore?: string; contextAfter?: string }

/** What the page sends. */
type Action =
  | ({ kind: 'open'; mode: Mode; message?: string } & Selection)
  | ({ kind: 'delete' } & Selection)
  | { kind: 'reply'; thread: string; mode: Mode; message: string }
  | { kind: 'archive'; thread: string }
  | { kind: 'trash'; thread: string }
  | { kind: 'collapse'; thread: string; collapsed: boolean }
  | { kind: 'undoRound'; thread: string; round: string }
  | { kind: 'redoRound'; thread: string; round: string }
  | { kind: 'acceptRound'; thread: string; round: string }
  | { kind: 'acceptHunk'; hunk: string }
  | { kind: 'revert'; hunk: string }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'review' }
  | { kind: 'cancel' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cotext',
      description: 'Review a file in the browser: question, comment or delete a passage, see the changes, then Revisar',
      argumentHint: '<file>',
    })
    await $.agent.register({
      name: REVISER,
      description: 'Answers a question or comment the person left on a passage in cotext, and proposes edits.',
      prompt: REVISER_PROMPT,
      tools: REVISER_TOOLS,
    })
    if ((await read($, fileAtom)) !== null) {
      startPolling($)
      void startServer($)
    }

    return next(e)
  })

  // The reviser is this mod's own: the conversation's model is not offered it.
  on('agent.offer', { agent: 'cotext:reviser' }, () => ({ isOffered: false }))

  on('command.run', { command: 'cotext' }, async ($, e) => {
    const path = e.args.trim().replace(/^@/, '').replace(/^["']|["']$/g, '').replace(/^\.\//, '')
    if (path === '') {
      const file = await read($, fileAtom)
      if (file === null) return { text: 'Usage: /cotext <file>' }
      await showPage($)

      return { text: `Reviewing ${file}.` }
    }

    const opened = await openFile($, path)
    if (opened !== undefined) return { text: opened }
    await showPage($)
    const changes = (await read($, hunksAtom)).length

    return { text: `Reviewing ${path}${changes > 0 ? ` (${changes} unsaved change${changes === 1 ? '' : 's'})` : ''}.` }
  })

  // An edit to the open file from the conversation reaches the draft at once.
  on('tool.call', async ($, e, next) => {
    const argument = EDIT_TOOLS[e.tool]
    if (argument === undefined) return next(e)

    const ran = await next(e)
    const path = (e as Record<string, unknown>)[argument]
    if (ran.deny === undefined && typeof path === 'string' && (await isOpenFile($, path))) await sync($)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      // Any turn may have changed the open file, a Bash sed among them.
      await sync($)

      return done
    }
    // A reviser's answer names its thread in its json block; one that wrote
    // none, or stopped short, is known by the loop it ran in.
    const threads = await read($, threadsAtom)
    const proposal = e.isAborted || e.reason !== 'answer' ? null : parseProposal(e.answer)
    const thread =
      threads.find(one => one.id === proposal?.thread && one.status === 'thinking') ??
      threads.find(one => one.agentId === e.agentId && one.status === 'thinking')
    if (thread !== undefined) await takeProposal($, thread.id, proposal)

    return done
  })

  // The page is where the review happens; the pane beside the transcript says where it is.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const file = await read($, fileAtom)
    if (file === null) return <Text dimColor>Run /cotext &lt;file&gt; to start a review.</Text>

    const server = await read($, serverAtom)
    const missing = await read($, missingAtom)
    const stale = await read($, staleAtom)
    const hunks = await read($, hunksAtom)
    const threads = await read($, threadsAtom)
    const thinking = threads.filter(one => one.status === 'thinking').length
    const width = Math.max(20, e.props.bodyColumns - 8)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text bold>{file}</Text>
          {server === null ? (
            <Text dimColor>starting the review page…</Text>
          ) : (
            <Link key="page" href={pageUrl(server)} label="open the review page" />
          )}
          {missing && <Text color="red">The file is gone from disk.</Text>}
          {stale && <Text color="red">The file changed on disk since the review began.</Text>}
        </Box>

        <Box flexDirection="row" columnGap={1}>
          <Button key="review" variant="primary" onPress={() => saveReview($)}>
            Revisar
          </Button>
          <Button key="undo" onPress={() => undo($)}>
            Desfazer
          </Button>
          <Button key="cancel" onPress={() => cancelReview($)}>
            Cancelar
          </Button>
          <Button key="browser" plain dimColor onPress={() => openBrowser($)}>
            browser
          </Button>
        </Box>

        <Text dimColor>
          {`${count(hunks.length, 'unsaved change')} · ${count(threads.length, 'thread')}` +
            (thinking > 0 ? ` · Claude is on ${thinking}…` : '')}
        </Text>

        <Box flexDirection="column">
          {threads.map(one => (
            <Box key={`row-${one.id}`} flexDirection="column">
              <Text color={one.mode === 'ask' ? 'yellow' : 'blue'} wrap="truncate-end">
                {`[${one.mode === 'ask' ? '?' : 'C'}] ${excerpt(one.messages[0]?.text || one.quote, width)}`}
              </Text>
              {one.status === 'thinking' ? (
                <Text dimColor>{'    ↳ …'}</Text>
              ) : (
                one.messages.length > 1 && (
                  <Text dimColor wrap="truncate-end">{`    ↳ ${excerpt(one.messages.at(-1)!.text, width)}`}</Text>
                )
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}

/** Starts the page's server if it is not up, opens the pane, and the browser once per load. */
async function showPage($: EngineInterface): Promise<void> {
  startPolling($)
  const server = await startServer($)
  await $.ui.open({ id: PANE, title: 'cotext' })
  if (server === undefined) {
    void $.ui.toast('cotext: the review page could not start; is `node` on the PATH?')

    return
  }
  await pushView($)
  if (!hasOpenedBrowser) await openBrowser($)
}

function pageUrl(server: Server): string {
  return `http://localhost:${server.port}/?t=${server.token}`
}

async function openBrowser($: EngineInterface): Promise<void> {
  const server = await read($, serverAtom)
  if (server === null) return
  hasOpenedBrowser = true
  for (const opener of ['open', 'xdg-open']) {
    try {
      if ((await $.process.run([opener, pageUrl(server)])).exitCode === 0) return
    } catch {
      // Not this platform's opener: try the next.
    }
  }
  void $.ui.toast(`cotext: open ${pageUrl(server)} in a browser.`)
}

/**
 * Starts the page's server, once per load of the module: on the port the last
 * load used when it is free, so a tab left open reconnects. Resolves where it
 * listens once it says so, or undefined when it could not start.
 */
function startServer($: EngineInterface): Promise<Server | undefined> {
  serving ??= new Promise<Server | undefined>(resolve => {
    void (async () => {
      const kept = await read($, serverAtom)
      const token = kept?.token ?? newToken()
      const argv = ['node', `${$.plugin.root}/server/server.mjs`, token, ...(kept === null ? [] : [String(kept.port)])]
      let isReady = false
      let buffer = ''
      try {
        for await (const chunk of $.process.spawn({ argv })) {
          if (chunk.stream !== 'stdout') {
            $.ui.log(`cotext server: ${chunk.text}`, { to: 'debug' })
            continue
          }
          buffer += chunk.text
          for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
            const line = buffer.slice(0, at)
            buffer = buffer.slice(at + 1)
            const said = parseLine(line)
            if (typeof said.ready === 'number') {
              const server = { port: said.ready, token }
              await update($, serverAtom, () => server)
              shownView = ''
              isReady = true
              resolve(server)
            } else if (said.poke === true) {
              void drain($)
            }
          }
        }
      } catch (error) {
        $.ui.log(`cotext server: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      }
      serving = undefined
      if (!isReady) resolve(undefined)
    })()
  })

  return serving
}

function parseLine(line: string): { ready?: unknown; poke?: unknown } {
  try {
    const value: unknown = JSON.parse(line)

    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

function newToken(): string {
  const part = () => Math.random().toString(36).slice(2, 12)

  return `${part()}${part()}${Date.now().toString(36)}`
}

/** Takes what the page queued and acts on it, one drain at a time. */
function drain($: EngineInterface): Promise<void> {
  draining = draining.then(() => drainOnce($)).catch(() => undefined)

  return draining
}

async function drainOnce($: EngineInterface): Promise<void> {
  const server = await read($, serverAtom)
  if (server === null) return
  let actions: unknown
  try {
    const got = await $.http.fetch(`http://127.0.0.1:${server.port}/actions`, {
      headers: { 'x-cotext-token': server.token },
    })
    if (!got.ok) return
    actions = JSON.parse(got.text)
  } catch {
    return
  }
  if (!Array.isArray(actions) || actions.length === 0) return
  for (const action of actions as Action[]) await handle($, action)
  await pushView($)
}

async function handle($: EngineInterface, action: Action): Promise<void> {
  switch (action.kind) {
    case 'open':
      return open($, action)
    case 'delete':
      return deletePassage($, action)
    case 'reply':
      return reply($, action.thread, action.mode, action.message)
    case 'archive':
      return putAway($, action.thread, true)
    case 'trash':
      return putAway($, action.thread, false)
    case 'collapse':
      return editThread($, action.thread, one => ({ ...one, collapsed: action.collapsed === true }))
    case 'undoRound':
      return stepRound($, action.thread, action.round, 'undo')
    case 'redoRound':
      return stepRound($, action.thread, action.round, 'redo')
    case 'acceptRound':
      return acceptRound($, action.thread, action.round)
    case 'acceptHunk':
      return commit($, [action.hunk])
    case 'revert':
      return void (await change($, hunks => hunks.filter(one => one.id !== action.hunk)))
    case 'undo':
      return undo($)
    case 'redo':
      return redo($)
    case 'review':
      return saveReview($)
    case 'cancel':
      return cancelReview($)
  }
}

/**
 * The view the page draws: the display text in blocks, the spans to strike,
 * colour and highlight in it, and the threads beside it. Posted only when it
 * changed, one post at a time, so an older view never lands after a newer one.
 */
function pushView($: EngineInterface): Promise<void> {
  posting = posting
    .then(() => postView($))
    .then(() => writeJournal($))
    .catch(() => undefined)

  return posting
}

async function postView($: EngineInterface): Promise<void> {
  const server = await read($, serverAtom)
  if (server === null) return
  const file = await read($, fileAtom)
  const base = await read($, baseAtom)
  const hunks = await read($, hunksAtom)
  const threads = await read($, threadsAtom)
  const shown = display(base, hunks)
  const work = working(base, hunks)
  const lines = lineStarts(work)
  const view = {
    file,
    syntax: file === null ? 'markdown' : syntaxOf(file),
    missing: await read($, missingAtom),
    stale: await read($, staleAtom),
    canUndo: (await read($, pastAtom)).length > 0,
    canRedo: (await read($, futureAtom)).length > 0,
    segments:
      file === null
        ? []
        : segmentsOf(file, shown.text).map(one => ({ ...one, line: lineAt(lines, displayToWorking(hunks, one.start)) })),
    spans: [
      ...shown.spans.map(one => ({ kind: one.kind, start: one.start, end: one.end, id: one.hunk })),
      ...threads
        .filter(one => !one.detached)
        .map(one => ({
          kind: 'thread' as const,
          start: baseToDisplay(hunks, one.start, 'start'),
          end: baseToDisplay(hunks, one.end, 'end'),
          id: one.id,
        })),
    ],
    // A change whose threads are gone (put away, then Desfazer brought it back) shows on its own.
    hunks: hunks.map(one => ({
      id: one.id,
      threads: one.threads.filter(id => threads.some(thread => thread.id === id)),
      removed: base.slice(one.start, one.end),
      added: one.text,
      at: baseToDisplay(hunks, one.start, 'start'),
    })),
    threads: threads.map(one => ({
      id: one.id,
      mode: one.mode,
      quote: one.quote,
      status: one.status,
      messages: one.messages,
      detached: one.detached === true,
      collapsed: one.collapsed === true,
      at: baseToDisplay(hunks, one.start, 'start'),
      line: lineAt(lines, baseToWorking(hunks, one.start, 'start')),
      changes: hunks.filter(hunk => hunk.threads.includes(one.id)).length,
      // The rounds with changes in the draft: the ones Aceitar can write.
      pending: one.messages.flatMap(message =>
        message.round !== undefined && hunks.some(hunk => hunk.rounds?.includes(message.round!)) ? [message.round] : [],
      ),
    })),
  }
  const text = JSON.stringify(view)
  if (text === shownView) return
  try {
    const sent = await $.http.fetch(`http://127.0.0.1:${server.port}/view`, {
      method: 'POST',
      headers: { 'x-cotext-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ ...view, version: ++viewVersion }),
    })
    if (sent.ok) shownView = text
  } catch {
    // The server is gone or starting again; the next look tries again.
  }
}

function segmentsOf(file: string, text: string): Segment[] {
  return syntaxOf(file) === 'markdown' ? segment(text) : chunkLines(text)
}

/** The offset each line of `text` starts at. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)

  return starts
}

/** The 1-based line holding `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }

  return low + 1
}

/**
 * Reads `path` in as the draft's base. The draft of the file already open is
 * kept; another file's starts with no changes and the threads its journal
 * kept. Answers why it could not, or undefined.
 */
async function openFile($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await $.fs.exists(path))) return `No such file: ${path}`
  let source: string
  try {
    source = await $.fs.read(path)
  } catch (error) {
    return `cotext: ${error instanceof Error ? error.message : String(error)}`
  }
  if ((await read($, fileAtom)) === path) {
    await sync($)

    return undefined
  }
  let journal: Journal | undefined
  const kept = journalPath(path)
  try {
    if (await $.fs.exists(kept)) journal = parseJournal(await $.fs.read(kept), kept)
  } catch (error) {
    return `cotext: ${error instanceof Error ? error.message : String(error)}`
  }
  // No file while the draft changes hands, so no journal is written with the other file's threads.
  await update($, fileAtom, () => null)
  await startOver($, source, journal === undefined ? [] : restoreThreads(journal, source, syntaxOf(path), new Date().toISOString()))
  await update($, acceptedAtom, () => journal?.accepted ?? [])
  await update($, missingAtom, () => false)
  await update($, fileAtom, () => path)

  return undefined
}

/** The draft from `base`, with no changes and the given threads. */
async function startOver($: EngineInterface, base: string, threads: Thread[]): Promise<void> {
  await update($, baseAtom, () => base)
  await update($, hunksAtom, () => [])
  await update($, pastAtom, () => [])
  await update($, futureAtom, () => [])
  await update($, threadsAtom, () => threads)
  await update($, staleAtom, () => false)
}

/**
 * Looks at the open file on disk. A change made there while the draft holds
 * none becomes the new base, the threads following their passages; one made
 * while it holds changes marks the draft stale, since Revisar would overwrite it.
 */
async function sync($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  if (!(await $.fs.exists(file))) {
    if (!(await read($, missingAtom))) {
      await update($, missingAtom, () => true)
      await pushView($)
    }

    return
  }
  if (await read($, missingAtom)) await update($, missingAtom, () => false)
  const disk = await $.fs.read(file)
  const base = await read($, baseAtom)
  const hunks = await read($, hunksAtom)
  if (disk === base) {
    if (await read($, staleAtom)) await update($, staleAtom, () => false)
  } else if (hunks.length === 0) {
    await update($, baseAtom, () => disk)
    await update($, pastAtom, () => [])
    await update($, futureAtom, () => [])
    await update($, threadsAtom, list => list.map(one => follow(one, base, disk)))
  } else if (!(await read($, staleAtom))) {
    await update($, staleAtom, () => true)
    void $.ui.toast(`cotext: ${file} changed on disk; Revisar would overwrite it. Cancelar takes the new text.`)
  }
  await pushView($)
}

/** A thread in `now`: where its passage still is, the one nearest its old place, or detached. */
function follow(thread: Thread, was: string, now: string): Thread {
  const text = was.slice(thread.start, thread.end)
  if (now.slice(thread.start, thread.end) === text) return thread
  let best: number | undefined
  for (let at = text === '' ? -1 : now.indexOf(text); at !== -1; at = now.indexOf(text, at + 1)) {
    if (best === undefined || Math.abs(at - thread.start) < Math.abs(best - thread.start)) best = at
  }
  if (best === undefined) return { ...thread, detached: true }
  const { detached: _, ...rest } = thread

  return { ...rest, start: best, end: best + text.length }
}

async function isOpenFile($: EngineInterface, path: string): Promise<boolean> {
  const file = await read($, fileAtom)
  if (file === null) return false
  try {
    const [edited, open] = await Promise.all([$.fs.stat(path, { resolve: true }), $.fs.stat(file, { resolve: true })])

    return edited.realPath !== undefined && edited.realPath === open.realPath
  } catch {
    return false
  }
}

/**
 * Finds what the person selected in the display text. The page says which
 * block the selection began in and the rendered text around it, so the search
 * runs in that block first and a passage that repeats is told apart there.
 * Answers it in the display text, the base and the working text.
 */
async function resolveSelection(
  $: EngineInterface,
  selection: Selection,
): Promise<{ base: [number, number]; work: [number, number] } | undefined> {
  const file = await read($, fileAtom)
  if (file === null || typeof selection.text !== 'string') return undefined
  const hunks = await read($, hunksAtom)
  const shown = display(await read($, baseAtom), hunks).text
  const syntax = syntaxOf(file)
  const hint = { contextBefore: selection.contextBefore ?? '', contextAfter: selection.contextAfter ?? '' }
  const block = segmentsOf(file, shown)[selection.seg]

  let span: { start: number; end: number } | undefined
  if (block !== undefined) {
    const found = pickOne(locate(block.text, selection.text, { syntax, hint }), 0)
    if (found !== undefined) span = { start: block.start + found.start, end: block.start + found.end }
  }
  // A selection across blocks is not in any one of them: the whole text, from that block on.
  span ??= pickOne(locate(shown, selection.text, { syntax, hint }), block?.start ?? 0)
  if (span === undefined) {
    void $.ui.toast(`Couldn't find that text in ${file}.`)

    return undefined
  }

  return {
    base: [displayToBase(hunks, span.start, 'start'), displayToBase(hunks, span.end, 'end')],
    work: [displayToWorking(hunks, span.start), displayToWorking(hunks, span.end)],
  }
}

/** The match, or of several the first at or after `from`. */
function pickOne(found: Located, from: number): { start: number; end: number } | undefined {
  if (found.kind === 'found') return found.anchor
  if (found.kind === 'missing') return undefined

  return found.anchors.find(one => one.start >= from) ?? found.anchors[0]
}

/** Questionar or Comentar: a thread on the passage, and a reviser to answer it. */
async function open($: EngineInterface, action: Extract<Action, { kind: 'open' }>): Promise<void> {
  if (!MODES.includes(action.mode)) return
  const message = typeof action.message === 'string' ? action.message.trim() : ''
  if (action.mode === 'comment' && message === '') return void $.ui.toast('A comment needs text.')
  const found = await resolveSelection($, action)
  if (found === undefined) return
  const thread: Thread = {
    id: randomId(),
    mode: action.mode,
    start: found.base[0],
    end: found.base[1],
    quote: action.text.trim(),
    messages: [{ from: 'user', text: message, at: new Date().toISOString(), mode: action.mode }],
    status: 'idle',
  }
  await update($, threadsAtom, list => [...list, thread])
  await runReviser($, thread.id)
}

/** A message on a thread, in the mode the person chose for it. */
async function reply($: EngineInterface, id: string, mode: Mode, message: string): Promise<void> {
  if (!MODES.includes(mode)) return
  const text = typeof message === 'string' ? message.trim() : ''
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  if (thread === undefined || text === '') return
  if (thread.status === 'thinking') return void $.ui.toast('cotext: Claude is still answering that one.')
  await editThread($, id, one => ({ ...one, messages: [...one.messages, { from: 'user', text, at: new Date().toISOString(), mode }] }))
  await runReviser($, id)
}

/** Spawns a reviser on the thread's passage as the draft has it now; its `turn.complete` brings the answer. */
async function runReviser($: EngineInterface, id: string): Promise<void> {
  const file = await read($, fileAtom)
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  if (file === null || thread === undefined) return
  const hunks = await read($, hunksAtom)
  const draft = working(await read($, baseAtom), hunks)
  const start = baseToWorking(hunks, thread.start, 'start')
  const end = baseToWorking(hunks, thread.end, 'end')
  const lines = lineStarts(draft)
  const lineStart = lineAt(lines, start)
  const symbol = syntaxOf(file) === 'code' ? enclosingSymbol(draft, lineStart) : undefined
  const prompt = buildAsk({
    id,
    file,
    draft,
    passage: {
      start,
      end,
      text: draft.slice(start, end),
      lineStart,
      lineEnd: lineAt(lines, Math.max(start, end - 1)),
      ...(symbol === undefined ? {} : { symbol }),
    },
    thread,
  })
  await editThread($, id, one => ({ ...one, status: 'thinking' }))
  await pushView($)
  try {
    const spawned = await $.agent.spawn({
      subagentType: REVISER_TYPE,
      description: lastAsked(thread) === 'ask' ? 'cotext: answer a question' : 'cotext: act on a comment',
      prompt,
    })
    if (spawned.deny !== undefined) throw new Error(spawned.deny)
    const agentId = spawned.agentId
    if (agentId !== undefined) await editThread($, id, one => ({ ...one, agentId }))
  } catch (error) {
    await editThread($, id, one => failed(one, `O revisor não pôde começar: ${error instanceof Error ? error.message : String(error)}`))
  }
  await pushView($)
}

/**
 * The reviser's proposal, or null when it stopped short: the reply joins the
 * thread and the edits the draft, as one step Desfazer takes back whole. An
 * answer to an ask changes nothing, whatever edits it proposed. The reply
 * keeps every edit proposed and where each applied one landed: the round its
 * balloon can take back and bring again.
 */
async function takeProposal($: EngineInterface, id: string, proposal: Proposal | null): Promise<void> {
  if (proposal === null) {
    await editThread($, id, one => failed(one, 'O revisor parou antes de responder.'))
    await pushView($)

    return
  }
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  if (thread === undefined) return
  const mode = lastAsked(thread)
  const edits = mode === 'ask' ? [] : proposal.edits
  const base = await read($, baseAtom)
  let hunks = await read($, hunksAtom)
  const missed: string[] = []
  const round: RoundEdit[] = []
  const roundId = randomId()
  for (const edit of edits) {
    const work = working(base, hunks)
    const at = findEdit(work, edit.old, baseToWorking(hunks, thread.start, 'start'))
    if (at === undefined) {
      missed.push(edit.old)
      round.push({ old: edit.old, new: edit.new, applied: false })
      continue
    }
    round.push({
      old: work.slice(at.start, at.end),
      new: edit.new,
      applied: true,
      before: work.slice(Math.max(0, at.start - EDIT_CONTEXT), at.start),
      after: work.slice(at.end, at.end + EDIT_CONTEXT),
    })
    hunks = applyEdit(base, hunks, at.start, at.end, edit.new, [id], randomId, [roundId])
  }
  // An ask's proposals are kept, never applied.
  if (mode === 'ask') round.push(...proposal.edits.map(edit => ({ old: edit.old, new: edit.new, applied: false })))
  if (missed.length < edits.length) await change($, () => hunks)
  const ignored = proposal.edits.length - edits.length
  const note =
    missed.length > 0
      ? `\n\n(${missed.length === 1 ? '1 alteração proposta não foi aplicada' : `${missed.length} alterações propostas não foram aplicadas`}: o trecho não está no rascunho.)`
      : ignored > 0
        ? '\n\n(Pergunta é só leitura: as alterações propostas foram ignoradas. Comente para alterar.)'
        : ''
  await editThread($, id, one => {
    const { agentId: _, ...rest } = one

    return {
      ...rest,
      status: 'idle',
      messages: [
        ...one.messages,
        {
          from: 'claude',
          text: (proposal.reply || '(sem resposta)') + note,
          at: new Date().toISOString(),
          mode,
          ...(round.length > 0 ? { round: roundId, edits: round } : {}),
        },
      ],
    }
  })
  await pushView($)
}

function failed(thread: Thread, why: string): Thread {
  const { agentId: _, ...rest } = thread

  const message = { from: 'claude' as const, text: why, at: new Date().toISOString(), mode: lastAsked(thread) }

  return { ...rest, status: 'error', messages: [...thread.messages, message] }
}

async function editThread($: EngineInterface, id: string, fn: (one: Thread) => Thread): Promise<void> {
  await update($, threadsAtom, list => list.map(one => (one.id === id ? fn(one) : one)))
}

/** Excluir: the passage struck through in the draft, at once. */
async function deletePassage($: EngineInterface, action: Extract<Action, { kind: 'delete' }>): Promise<void> {
  const found = await resolveSelection($, action)
  if (found === undefined || found.work[0] === found.work[1]) return
  const base = await read($, baseAtom)
  await change($, hunks => applyEdit(base, hunks, found.work[0], found.work[1], ''))
}

/**
 * One step of the draft: what it was goes on Desfazer's stack, and Refazer's
 * is dropped. `rounds` are the rounds the step takes back or brings again.
 */
async function change(
  $: EngineInterface,
  fn: (hunks: Hunk[]) => Hunk[],
  rounds: { thread: string; round: string; undone: boolean }[] = [],
): Promise<boolean> {
  const before = await read($, hunksAtom)
  const after = fn(before)
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) return false
  const step = await currentStep($)
  await update($, pastAtom, past => [...past, step].slice(-MAX_HISTORY))
  await update($, futureAtom, () => [])
  await update($, hunksAtom, () => after)
  for (const one of rounds) {
    await editThread($, one.thread, thread => ({
      ...thread,
      messages: thread.messages.map(message => (message.round === one.round ? { ...message, undone: one.undone } : message)),
    }))
  }
  await pushView($)

  return true
}

/** The draft as it is now, as Desfazer and Refazer keep it. */
async function currentStep($: EngineInterface): Promise<Step> {
  const undone = (await read($, threadsAtom)).flatMap(one =>
    one.messages.filter(message => hasApplied(message) && message.undone === true).map(message => message.round!),
  )

  return { hunks: await read($, hunksAtom), undone }
}

/** Puts the draft back as `step` had it, its rounds taken back or not alike. */
async function restore($: EngineInterface, step: Step): Promise<void> {
  await update($, hunksAtom, () => step.hunks)
  await update($, threadsAtom, list =>
    list.map(one =>
      one.messages.some(hasApplied)
        ? {
            ...one,
            messages: one.messages.map(message =>
              hasApplied(message) ? { ...message, undone: step.undone.includes(message.round!) } : message,
            ),
          }
        : one,
    ),
  )
}

async function undo($: EngineInterface): Promise<void> {
  const past = await read($, pastAtom)
  if (past.length === 0) return
  const now = await currentStep($)
  await update($, pastAtom, () => past.slice(0, -1))
  await update($, futureAtom, future => [...future, now])
  await restore($, past.at(-1)!)
  await pushView($)
}

async function redo($: EngineInterface): Promise<void> {
  const future = await read($, futureAtom)
  if (future.length === 0) return
  const now = await currentStep($)
  await update($, futureAtom, () => future.slice(0, -1))
  await update($, pastAtom, past => [...past, now])
  await restore($, future.at(-1)!)
  await pushView($)
}

/**
 * Desfazer or Refazer on one round of a thread: its applied edits taken back
 * (each `new` becomes its `old` again, last first) or made again (first
 * first). Each is found by the text around where it landed; when one is no
 * longer there, the text changed since and nothing is done.
 */
async function stepRound($: EngineInterface, id: string, round: string, way: 'undo' | 'redo'): Promise<void> {
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  const message = thread?.messages.find(one => one.round === round)
  if (thread === undefined || message === undefined || !hasApplied(message)) return
  if ((message.undone === true) === (way === 'undo')) return
  const base = await read($, baseAtom)
  let hunks = await read($, hunksAtom)
  const applied = message.edits!.filter(one => one.applied)
  for (const edit of way === 'undo' ? [...applied].reverse() : applied) {
    const [from, to] = way === 'undo' ? [edit.new, edit.old] : [edit.old, edit.new]
    const at = findAgain(working(base, hunks), edit, from, baseToWorking(hunks, thread.start, 'start'))
    if (at === undefined) {
      return void $.ui.toast(
        `cotext: o texto mudou desde essa rodada; não dá para ${way === 'undo' ? 'desfazê-la' : 'refazê-la'}.`,
      )
    }
    hunks = applyEdit(base, hunks, at.start, at.end, to, [id], randomId, [round])
  }
  const done = await change($, () => hunks, [{ thread: id, round, undone: way === 'undo' }])
  // The draft already reads as the round would leave it: only its mark moves.
  if (!done) {
    await editThread($, id, one => ({
      ...one,
      messages: one.messages.map(m => (m.round === round ? { ...m, undone: way === 'undo' } : m)),
    }))
    await pushView($)
  }
}

/**
 * Where `text`, one side of a round's edit, is in the working text: with the
 * text that was around it, then a little of it, then alone (unless empty), of
 * several the one nearest `near`.
 */
function findAgain(work: string, edit: RoundEdit, text: string, near: number): { start: number; end: number } | undefined {
  const before = edit.before ?? ''
  const after = edit.after ?? ''
  for (const keep of [EDIT_CONTEXT, 12]) {
    const head = before.slice(-keep)
    const tail = after.slice(0, keep)
    if (head === '' && tail === '' && text === '') continue
    const at = nearest(work, head + text + tail, near)
    if (at !== undefined) return { start: at + head.length, end: at + head.length + text.length }
  }
  if (text === '') return undefined
  const at = nearest(work, text, near)

  return at === undefined ? undefined : { start: at, end: at + text.length }
}

/** The start of `text` in `work` nearest `near`. */
function nearest(work: string, text: string, near: number): number | undefined {
  let best: number | undefined
  for (let at = work.indexOf(text); at !== -1; at = work.indexOf(text, at + 1)) {
    if (best === undefined || Math.abs(at - near) < Math.abs(best - near)) best = at
  }

  return best
}

/**
 * Arquivar or the Lixeira: the thread's unsaved changes leave the draft and
 * the thread leaves the review. Archived, it is first added whole, every
 * round with what it proposed, to the file's archive under `.review/archive/`.
 */
async function putAway($: EngineInterface, id: string, archive: boolean): Promise<void> {
  const file = await read($, fileAtom)
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  if (file === null || thread === undefined) return
  if (thread.status === 'thinking') return void $.ui.toast('cotext: Claude is still answering that one.')
  if (archive) {
    const path = archivePath(file)
    try {
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
      const at = new Date().toISOString()
      await $.fs.write(path, appendArchive(existing, path, file, await read($, baseAtom), dropUnsaved(thread), at))
    } catch (error) {
      return void $.ui.toast(`cotext: could not archive: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await change($, hunks => hunks.filter(one => !one.threads.includes(id)))
  await update($, threadsAtom, list => list.filter(one => one.id !== id))
  await pushView($)
}

/** Revisar: every change of the draft is written to the file. */
async function saveReview($: EngineInterface): Promise<void> {
  return commit($, (await read($, hunksAtom)).map(one => one.id))
}

/** Aceitar on one round: the changes it made in the draft are written to the file, the rest stay. */
async function acceptRound($: EngineInterface, id: string, round: string): Promise<void> {
  const thread = (await read($, threadsAtom)).find(one => one.id === id)
  const message = thread?.messages.find(one => one.round === round)
  if (message === undefined || message.undone === true) return
  const ids = (await read($, hunksAtom)).filter(one => one.rounds?.includes(round)).map(one => one.id)
  if (ids.length === 0) return void $.ui.toast('cotext: essa rodada não tem alterações a aceitar.')

  return commit($, ids)
}

/**
 * Writes the hunks `ids` to the file: they leave the draft for its base, and
 * the other hunks stay as changes over it. The threads stay, on the text they
 * now sit in; a round whose changes all reached the file is marked so. The
 * conversation is told, so Claude knows the file changed.
 */
async function commit($: EngineInterface, ids: readonly string[]): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const hunks = await read($, hunksAtom)
  const taken = hunks.filter(one => ids.includes(one.id))
  if (taken.length === 0) return void $.ui.toast('cotext: no changes to save.')
  if (await read($, staleAtom)) {
    return void $.ui.toast(`cotext: ${file} changed on disk since the review began; Cancelar takes the new text.`)
  }
  const base = await read($, baseAtom)
  const next = acceptHunks(base, hunks, ids)
  try {
    await $.fs.write(file, next.base)
  } catch (error) {
    return void $.ui.toast(`cotext: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const isAll = next.hunks.length === 0
  const saved = (message: Message) =>
    hasApplied(message) &&
    (isAll || (taken.some(one => one.rounds?.includes(message.round!)) && !next.hunks.some(one => one.rounds?.includes(message.round!))))
  const threads = (await read($, threadsAtom)).map(one => ({
    ...one,
    start: baseToWorking(taken, one.start, 'start'),
    end: baseToWorking(taken, one.end, 'end'),
    // What each such round left in the draft is now in the file.
    messages: one.messages.map(message => (saved(message) ? { ...message, onDisk: message.undone !== true } : message)),
  }))
  await update($, acceptedAtom, list => [...list, acceptedOf(base, taken, new Date().toISOString())])
  await startOver($, next.base, threads)
  // Desfazer's steps were over the old base: they go, as on a whole Revisar.
  await update($, hunksAtom, () => next.hunks)
  await pushView($)
  void $.ui.toast(`cotext: saved ${count(taken.length, 'change')} to ${file}.`)
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: savedNote(file, base, taken) }] } })
  } catch (error) {
    // The conversation could not take the note; the file is saved all the same.
    $.ui.log(`cotext: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

/** What the conversation is told on Revisar: the file, and each change in a line. */
function savedNote(file: string, base: string, hunks: readonly Hunk[]): string {
  const shown = hunks.slice(0, 30).map(one => {
    const removed = base.slice(one.start, one.end)
    const said =
      removed === '' ? `added "${excerpt(one.text, 80)}"` : one.text === '' ? `removed "${excerpt(removed, 80)}"` : `"${excerpt(removed, 80)}" → "${excerpt(one.text, 80)}"`

    return `- ${said}`
  })
  const more = hunks.length > 30 ? [`- and ${hunks.length - 30} more`] : []

  return [`cotext: the user reviewed \`${file}\` and saved ${count(hunks.length, 'change')} to it:`, ...shown, ...more].join('\n')
}

/**
 * Cancelar: drops every change and takes the file as it is on disk. The
 * threads stay, following their passages; one whose proposals are dropped is told so.
 */
async function cancelReview($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const base = await read($, baseAtom)
  const hunks = await read($, hunksAtom)
  const disk = (await $.fs.exists(file)) ? await $.fs.read(file) : base
  const at = new Date().toISOString()
  const threads = (await read($, threadsAtom)).map(one => {
    const moved = dropUnsaved(follow(one, base, disk))
    const proposed = hunks.filter(hunk => hunk.threads.includes(one.id)).length

    return proposed === 0 ? moved : { ...moved, messages: [...moved.messages, { from: 'claude' as const, text: discarded(proposed), at, mode: lastAsked(one) }] }
  })
  const dropped = hunks.length
  await startOver($, disk, threads)
  await pushView($)
  void $.ui.toast(`cotext: discarded ${count(dropped, 'change')}.`)
}

/**
 * Writes the open file's journal when it changed: the threads and what
 * Revisar wrote, never the unsaved changes. A file with neither gets none.
 */
async function writeJournal($: EngineInterface): Promise<void> {
  const file = await read($, fileAtom)
  if (file === null) return
  const threads = await read($, threadsAtom)
  const accepted: Accepted[] = await read($, acceptedAtom)
  const text = serializeJournal(file, await read($, baseAtom), await read($, hunksAtom), threads, accepted)
  if (text === writtenJournal) return
  const path = journalPath(file)
  try {
    if (threads.length > 0 || accepted.length > 0 || (await $.fs.exists(path))) await $.fs.write(path, text)
    writtenJournal = text
  } catch (error) {
    $.ui.log(`cotext: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

/** One look at what may have changed outside the mod: the open file, the page's queue. */
async function tick($: EngineInterface): Promise<void> {
  await sync($)
  // A poke the server sent while the mod was reloading is not lost.
  await drain($)
}

/** Watches the open file and the page's queue, once per load of the module. */
function startPolling($: EngineInterface): void {
  polling ??= $.clock.every(POLL_MS, () => void tick($))
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`
}
