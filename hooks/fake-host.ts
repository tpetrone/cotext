// What a session would answer beneath the plugin, for the engine tests: a
// filesystem in memory, a selection, the prompt queue, an Edit tool and git.

import type { On } from 'claude-code'

import type { ReviewFile } from '../types'

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

export type Host = {
  files: Map<string, string>
  select: (text: string | undefined) => void
  toasts: string[]
  submitted: string[]
  /** The renames `git diff HEAD` reports, `[from, to]`; set by a test. */
  renames: [string, string][]
  /** The annotations review.json holds now. */
  saved: () => ReviewFile['annotations']
}

// The engine hands fs hooks absolute paths, resolved against the plugin's folder.
const relative = (path: string) => path.split('/cotext/').pop()!

export function fakeHost(on: On, files: Record<string, string>): Host {
  const host: Host = {
    files: new Map(Object.entries(files)),
    select: text => {
      selected = text
    },
    toasts: [],
    submitted: [],
    renames: [],
    saved: () => {
      const text = host.files.get('.review/review.json')

      return text === undefined ? [] : (JSON.parse(text) as ReviewFile).annotations
    },
  }
  let selected: string | undefined

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
    const isDiff = e.argv[1] === 'diff'
    const stdout = isDiff ? host.renames.map(([from, to]) => `R100\0${from}\0${to}\0`).join('') : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.selection', () => ({ value: selected === undefined ? undefined : { text: selected } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.toast', (_, e) => {
    host.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    host.submitted.push(e.text)

    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
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
