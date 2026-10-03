import { expect, mock, test } from 'claude-code/testing'

import type { ReviewFile } from '../types'
import { OPEN, PANE, fakeHost } from './fake-host'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane takes in review.json changed outside it on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('SQLite será o storage.')
    await ui.press({ key: 'highlight' })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })

    // Someone deletes the first annotation by hand.
    const [first, second] = host.saved()
    const kept: ReviewFile = { version: 1, annotations: [second!] }
    host.files.set('.review/review.json', JSON.stringify(kept))
    await clock.advance(2000)
    await ui.press({ key: 'notes' })
    expect(await ui.find({ key: `go-${first!.id}` })).toBeUndefined()
    expect(await ui.find({ key: `go-${second!.id}` })).toBeDefined()

    // A later write starts from the file, so the deletion holds.
    host.files.set('.review/review.json', JSON.stringify({ version: 1, annotations: [] }))
    host.select('SQLite será o storage.')
    await ui.press({ key: 'accept' })
    expect(host.saved().map(one => one.type)).toEqual(['accept'])

    // A file that does not parse is never written over.
    host.files.set('.review/review.json', '{ broken')
    await clock.advance(2000)
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })
    expect(host.files.get('.review/review.json')).toBe('{ broken')
    expect(host.toasts.at(-1)).toContain('does not parse')
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane follows edits to the open file and marks them on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })

    // The agent edits the file; no command is run.
    host.files.set('spec.md', SPEC.replace('SQLite será o storage.', 'Postgres será o storage.'))
    await clock.advance(2000)
    expect(await ui.find({ text: /Postgres/ })).toBeDefined()
    expect(await ui.find({ text: /updated now · L3/ })).toBeDefined()

    // The mark fades.
    await clock.advance(40_000)
    expect(await ui.find({ text: /updated now/ })).toBeUndefined()

    // A rewritten passage is "text changed", with its likely new place.
    host.files.set('spec.md', host.files.get('spec.md')!.replace('A API será REST.', 'A API será gRPC.'))
    await clock.advance(2000)
    expect(host.saved()[0]).toMatchObject({ detached: 'text' })
    expect(host.saved()[0]!.guess?.text).toBe('A API será gRPC.')
    await ui.press({ key: 'notes' })
    expect(await ui.find({ text: /text changed/ })).toBeDefined()
    expect(await ui.find({ text: /approximate, now L5/ })).toBeDefined()
    await ui.unmount()
  })

  test(`the pane follows a rename, or warns when the file is gone on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const host = fakeHost(on, { 'a.md': SPEC })
    await $.command.run(OPEN('a.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })

    host.files.set('b.md', host.files.get('a.md')!)
    host.files.delete('a.md')
    host.renames = [['a.md', 'b.md']]
    await clock.advance(2000)
    expect(host.saved()[0]!.file).toBe('b.md')
    expect(await ui.find({ text: /is gone from disk/ })).toBeUndefined()

    host.files.delete('b.md')
    host.renames = []
    await clock.advance(2000)
    expect(await ui.find({ text: /is gone from disk/ })).toBeDefined()
    await ui.unmount()
  })
}
