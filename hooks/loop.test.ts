import { expect, mock, test } from 'claude-code/testing'

import { OPEN, fakeHost } from './fake-host'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')

const EDIT = {
  tool: 'Edit',
  file_path: '/work/cotext/spec.md',
  old_string: '# Plan\n',
  new_string: '# Plan\n\nIntro.\n',
} as const

test('an edit on disk with no changes in the draft becomes its base, the threads following', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'open', mode: 'ask', text: 'A API será REST.', seg: 2 })
  await clock.advance(2000)
  expect(host.view()!.threads[0]!.line).toBe(5)

  // Claude edits the file in the conversation: the page follows at once.
  await $.tool.call(EDIT)
  expect(host.shown()).toContain('Intro.')
  expect(host.view()).toMatchObject({ stale: false, threads: [{ line: 7, detached: false }] })
})

test('an edit on disk while the draft holds changes blocks Revisar until Cancelar', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'delete', text: 'SQLite será o storage.', seg: 1 })
  await clock.advance(2000)

  host.files.set('spec.md', SPEC.replace('REST', 'GraphQL'))
  await clock.advance(2000)
  expect(host.view()!.stale).toBe(true)

  host.page({ kind: 'review' })
  await clock.advance(2000)
  expect(host.files.get('spec.md')).toBe(SPEC.replace('REST', 'GraphQL'))
  expect(host.toasts.at(-1)).toMatch(/changed on disk since the review began/)

  host.page({ kind: 'cancel' })
  await clock.advance(2000)
  expect(host.view()).toMatchObject({ stale: false, hunks: [] })
  expect(host.shown()).toContain('GraphQL')
})

test('the file gone from disk is flagged', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.files.delete('spec.md')
  await clock.advance(2000)
  expect(host.view()!.missing).toBe(true)
})
