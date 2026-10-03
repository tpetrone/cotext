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
    await ui.press({ key: 'notes' })
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
    await ui.press({ key: 'notes' })
    expect(await ui.find({ text: /\[H\] L7/ })).toBeDefined()

    await $.turn.complete(COMPLETE('t2'))
    expect(host.toasts.at(-1)).toBe('cotext: 0 resolved, 0 need you, 1 not reported back.')
    await ui.unmount()
  })

  test(`a handed-back decision closes by id later, across a rename, on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'skills/expand/SKILL.md': SPEC })
    await $.command.run(OPEN('skills/expand/SKILL.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })
    const id = host.saved()[0]!.id

    await ui.press({ key: 'send-review' })
    expect(host.submitted[0]).toContain(`ANNOTATION 1: highlight (L5) · id ${id}`)
    await $.turn.start({ text: host.submitted[0]!, turnId: 't1' })
    await $.tool.call({
      tool: 'mcp__cotext__resolve_annotations',
      items: [{ n: 1, status: 'needs_human', summary: 'REST ou gRPC?' }],
    })
    await $.turn.complete(COMPLETE('t1'))

    // In plain chat the user decides, Claude rewrites the passage and moves the file.
    host.files.delete('skills/expand/SKILL.md')
    host.files.set('skills/expandir/SKILL.md', SPEC.replace('A API será REST.', 'A API será gRPC.'))
    host.renames = [['skills/expand/SKILL.md', 'skills/expandir/SKILL.md']]
    await $.turn.complete(COMPLETE('t2'))
    expect(host.saved()[0]).toMatchObject({ file: 'skills/expandir/SKILL.md', detached: 'text' })
    await ui.press({ key: 'notes' })
    expect(await ui.find({ text: /\[H\] L5 .*\(text changed\)/ })).toBeDefined()

    // No review is open: the tool lists what waits, and closes it by id.
    const listed = await $.tool.call({ tool: 'mcp__cotext__resolve_annotations', items: [] })
    expect(listed.result).toContain(`id ${id}: skills/expandir/SKILL.md L5 (text changed): REST ou gRPC?`)
    const closed = await $.tool.call({
      tool: 'mcp__cotext__resolve_annotations',
      items: [{ id, status: 'resolved', summary: 'Trocado para gRPC.' }],
    })
    expect(closed.result).toBe('Recorded 1 annotation.')
    expect(host.saved()[0]!.status).toBe('resolved')
    await ui.unmount()
  })

  test(`an annotation whose file is gone with no rename is detached on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': SPEC, 'other.md': '# Other\n' })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('A API será REST.')
    await ui.press({ key: 'highlight' })
    await $.command.run(OPEN('other.md'))

    host.files.delete('spec.md')
    await $.turn.complete(COMPLETE('t1'))
    expect(host.saved()[0]!.detached).toBe('file')
    await ui.press({ key: 'scope' })
    await ui.press({ key: 'notes' })
    expect(await ui.find({ text: /\(file gone\)/ })).toBeDefined()
    await ui.unmount()
  })
}
