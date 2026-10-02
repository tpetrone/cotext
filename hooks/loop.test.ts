import { expect, test } from 'claude-code/testing'

import { OPEN, PANE, fakeHost } from './fake-host'

const SPEC = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')

const COMPLETE = (turnId: string) =>
  ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }) as const

const EDIT = {
  tool: 'Edit',
  file_path: '/work/cotext/spec.md',
  old_string: '# Plan\n',
  new_string: '# Plan\n\nIntro.\n',
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Review turn blocks edits and Claude resolves annotations on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('SQLite será o storage.')
    await ui.press({ key: 'highlight' })
    host.select('A API será REST.')
    await ui.press({ key: 'accept' })

    await ui.press({ key: 'send-review' })
    await $.turn.start({ text: host.submitted[0]!, turnId: 't1' })

    const blocked = await $.tool.call(EDIT)
    expect(blocked.deny).toContain('Review turn')
    expect(host.files.get('spec.md')).toBe(SPEC)

    const reply = await $.tool.call({
      tool: 'mcp__cotext__resolve_annotations',
      items: [
        { n: 1, status: 'needs_human', summary: 'Depende do volume esperado.' },
        { n: 2, status: 'resolved', summary: 'Mantido.' },
      ],
    })
    expect(reply.result).toBe('Recorded 2 of 2 annotations.')
    expect(host.saved().map(one => one.status)).toEqual(['needs_human', 'resolved'])
    expect(await ui.find({ text: /Depende do volume esperado/ })).toBeDefined()
    expect(await ui.find({ key: 'resolved' })).toBeDefined()

    await $.turn.complete(COMPLETE('t1'))
    expect(host.toasts.at(-1)).toBe('cotext: 1 resolved, 1 need you.')

    // The lock ends with its turn.
    const allowed = await $.tool.call(EDIT)
    expect(allowed.deny).toBeUndefined()
    await ui.unmount()
  })

  test(`an Apply turn edits and the annotations follow the text on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': SPEC })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })
    expect(host.saved()[0]!.anchor.lineStart).toBe(5)

    await ui.press({ key: 'send-apply' })
    expect(host.submitted[0]).toContain('Mode: APPLY')
    await $.turn.start({ text: host.submitted[0]!, turnId: 't2' })

    const edited = await $.tool.call(EDIT)
    expect(edited.deny).toBeUndefined()
    expect(host.saved()[0]!.anchor.lineStart).toBe(7)
    expect(await ui.find({ text: /\[H\] L7/ })).toBeDefined()

    await $.turn.complete(COMPLETE('t2'))
    expect(host.toasts.at(-1)).toBe('cotext: 0 resolved, 0 need you, 1 not reported back.')
    await ui.unmount()
  })
}
