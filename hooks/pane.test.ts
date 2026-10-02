import { expect, test } from 'claude-code/testing'

import { OPEN, PANE, fakeHost } from './fake-host'

const SPEC = [
  '# Architecture',
  '',
  'Para persistência local, **SQLite** será utilizado como storage principal.',
  '',
  'A API será REST.',
].join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`annotates a selection and sends the review on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': SPEC })

    const opened = await $.command.run(OPEN('@spec.md'))
    expect(opened.text).toBe('Reviewing spec.md (0 active annotations).')

    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })

    // A question asks for a note before it is saved.
    host.select('SQLite será utilizado')
    await ui.press({ key: 'question' })
    expect(host.saved()).toHaveLength(0)
    await ui.input({ key: 'note', text: 'Por que SQLite?' })
    expect(host.saved()[0]).toMatchObject({
      file: 'spec.md',
      type: 'question',
      comment: 'Por que SQLite?',
      status: 'open',
      anchor: { selectedText: 'SQLite** será utilizado', lineStart: 3 },
    })
    expect(await ui.find({ text: /\[\?\] L3 {2}Por que SQLite\?/ })).toBeDefined()

    // A highlight saves at once.
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })
    expect(host.saved()).toHaveLength(2)

    // Text that is not in the file is refused.
    host.select('Postgres')
    await ui.press({ key: 'reject' })
    expect(host.toasts.at(-1)).toContain("Couldn't find that text")

    await ui.press({ key: 'send-review' })
    expect(host.submitted).toHaveLength(1)
    expect(host.submitted[0]).toContain('ANNOTATION 1: question (L3)')
    expect(host.submitted[0]).toContain('Note: Por que SQLite?')
    expect(host.submitted[0]).toContain('ANNOTATION 2: highlight (L5)')
    expect(host.submitted[0]).toContain('Mode: REVIEW')

    await ui.unmount()
  })
}
