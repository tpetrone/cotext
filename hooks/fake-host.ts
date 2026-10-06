// What a session would answer beneath the plugin, for the engine tests: a
// filesystem in memory, the review page's server, subagents and an Edit tool.

import type { On } from 'claude-code'

/** The pane as a docked terminal or desktop draws it. */
export const PANE = {
  component: 'Pane',
  requestId: 'cotext',
  props: {
    title: 'cotext',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** `/cotext <args>` as the person types it. */
export const OPEN = (args: string) =>
  ({
    command: 'cotext',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  }) as const

/**
 * A reviser's turn ending with its answer: prose, then the json block naming
 * its thread. The test kit gives a spawn no agent id, so the block is what
 * ties the answer to its thread here.
 */
export const DONE = (thread: string, reply: string, edits: { old: string; new: string }[] = []) =>
  ({
    turnId: `turn-${thread}`,
    agentId: `agent-${thread}`,
    answer: `Pronto.\n\n\`\`\`json\n${JSON.stringify({ thread, reply, edits })}\n\`\`\``,
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  }) as const

export type ViewThread = {
  id: string
  mode: string
  quote: string
  status: string
  messages: {
    from: string
    text: string
    mode: string
    round?: string
    edits?: { old: string; new: string; applied: boolean }[]
    undone?: boolean
    onDisk?: boolean
  }[]
  detached: boolean
  collapsed: boolean
  scope?: 'doc'
  pending: string[]
  line: number
  changes: number
}

/** The view the mod last posted to the page's server. */
export type View = {
  version: number
  file: string | null
  syntax: string
  missing: boolean
  stale: boolean
  canUndo: boolean
  canRedo: boolean
  segments: { start: number; end: number; line: number; text: string }[]
  spans: { kind: 'del' | 'ins' | 'thread'; start: number; end: number; id: string }[]
  hunks: { id: string; threads: string[]; removed: string; added: string }[]
  threads: ViewThread[]
}

export type Host = {
  files: Map<string, string>
  toasts: string[]
  /** What the subagents the mod spawned were asked, in order. */
  spawned: { subagentType?: string; prompt: string }[]
  /** What the page shows now; undefined before the mod posted one. */
  view: () => View | undefined
  /** The display text the page draws, its blocks joined. */
  shown: () => string
  /** Queues what the person did on the page, as its server would; the mod takes it on its next look. */
  page: (action: Record<string, unknown>) => void
  /** The commands the mod ran to open the browser. */
  opened: string[][]
  /** How the mod started the server. */
  servers: string[][]
}

// The engine hands fs hooks absolute paths, resolved against the plugin's folder.
const relative = (path: string) => path.split('/cotext/').pop()!

const PORT = 4711

export function fakeHost(on: On, files: Record<string, string>): Host {
  let view: View | undefined
  let queue: Record<string, unknown>[] = []
  const host: Host = {
    files: new Map(Object.entries(files)),
    toasts: [],
    spawned: [],
    view: () => view,
    shown: () => {
      const segments = view?.segments ?? []

      return segments.map(one => one.text).join('|')
    },
    page: action => {
      queue.push(action)
    },
    opened: [],
    servers: [],
  }

  on('fs.exists', (_, e) => ({ value: host.files.has(relative(e.path)) }))
  on('fs.read', (_, e) => {
    const text = host.files.get(relative(e.path))
    if (text === undefined) throw new Error(`missing ${e.path}`)

    return { value: text }
  })
  on('fs.write', (_, e) => {
    host.files.set(relative(e.path), e.text)

    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: `/work/${relative(e.path)}` },
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'open') host.opened.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The server says where it listens, then stays up for the test's life.
  on('process.spawn', async function* (_, e) {
    host.servers.push([...e.argv])
    yield { stream: 'stdout' as const, text: `{"ready":${PORT}}\n` }
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const answer = (value: unknown) => ({
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) },
    })
    if (path === '/view') {
      view = JSON.parse(e.init?.body ?? '{}') as View
      return answer({ ok: true })
    }
    if (path === '/actions') {
      const taken = queue
      queue = []
      return answer(taken)
    }
    throw new Error(`no fake for ${e.url}`)
  })
  on('agent.register', (_, e) => ({ value: { agent: `cotext:${e.name}` } }))
  // The spawn reaches the engine as the Agent tool's arguments.
  on('agent.spawn', (_, e) => {
    const call = e as unknown as { subagent_type?: string; prompt: string }
    host.spawned.push({ subagentType: call.subagent_type, prompt: call.prompt })

    return { model: 'test' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    host.toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'Edit') throw new Error(`no fake for ${e.tool}`)
    const path = relative(e.file_path)
    const text = host.files.get(path) ?? ''
    host.files.set(path, text.replace(e.old_string, e.new_string))

    return { result: { filePath: e.file_path } } as never
  })

  return host
}
