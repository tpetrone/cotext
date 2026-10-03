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

    // Each Markdown block carries the number of its first line.
    expect(await ui.find({ type: 'Text', text: '5' })).toBeDefined()

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
    await ui.press({ key: 'notes' })
    expect(await ui.find({ text: /\[\?\] L3 {2}Por que SQLite\?/ })).toBeDefined()

    // A highlight saves at once, even with the line number in the selection.
    host.select('5 A API será REST.')
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

  test(`a selection that fits several places asks which one on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': '# Plan\n\nO storage local.\n\nO storage remoto.\n' })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })

    host.select('storage')
    await ui.press({ key: 'highlight' })
    expect(host.saved()).toHaveLength(0)
    expect(await ui.find({ text: /appears 2 times/ })).toBeDefined()
    expect(await ui.find({ key: 'pick-0', text: /L3 .*O \[storage\] local/ })).toBeDefined()

    await ui.press({ key: 'pick-1' })
    expect(host.saved()).toHaveLength(1)
    expect(host.saved()[0]!.anchor).toMatchObject({ selectedText: 'storage', lineStart: 5 })
    expect(await ui.find({ text: /appears 2 times/ })).toBeUndefined()

    // A kind that asks for a note goes on to the note once a place is picked.
    host.select('storage')
    await ui.press({ key: 'comment' })
    await ui.press({ key: 'pick-0' })
    await ui.input({ key: 'note', text: 'Qual?' })
    expect(host.saved()[1]).toMatchObject({ comment: 'Qual?', anchor: { lineStart: 3 } })
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the keyboard moves a cursor, selects in visual mode and marks on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'spec.md': ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n') })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })

    // No mouse: the first key places the cursor, two more reach the third line; 4 accepts it.
    await ui.press({ key: 'down' })
    await ui.press({ key: 'down' })
    await ui.press({ key: 'down' })
    await ui.press({ key: 'accept' })
    expect(host.saved()[0]!).toMatchObject({ type: 'accept', anchor: { selectedText: 'SQLite será o storage.' } })

    // From the start of the line: v, w w moves two words, and 1 marks what v..cursor spans.
    await ui.press({ key: 'home' })
    await ui.press({ key: 'visual' })
    await ui.press({ key: 'word' })
    await ui.press({ key: 'right' })
    await ui.press({ key: 'highlight' })
    expect(host.saved()[1]!.anchor.selectedText).toBe('SQLite se')
    expect(await ui.find({ text: /NORMAL/ })).toBeDefined()
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`insert mode edits the file from the cursor and undoes on ${surface}`, async ($, on) => {
    const original = ['# Plan', '', 'SQLite será o storage.', '', 'A API será REST.', ''].join('\n')
    const host = fakeHost(on, { 'spec.md': original })
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    for (let i = 0; i < 3; i++) await ui.press({ key: 'down' })

    // c edits the line in the field, and each keystroke lands in the file.
    await ui.press({ key: 'edit-change' })
    expect(await ui.find({ text: /INSERT/ })).toBeDefined()
    await ui.input({ key: 'edit', text: 'SQLite será o', kind: 'change' })
    expect(host.files.get('spec.md')).toBe(original.replace('o storage.', 'o'))
    await ui.input({ key: 'edit', text: 'Postgres será o storage.', kind: 'change' })
    expect(host.files.get('spec.md')).toBe(original.replace('SQLite', 'Postgres'))
    await ui.input({ key: 'edit', text: 'Postgres será o storage.' })
    expect(await ui.find({ text: /NORMAL/ })).toBeDefined()
    expect(await ui.find({ text: /Postgres/ })).toBeDefined()

    // o opens a line below; d removes it again.
    await ui.press({ key: 'edit-open' })
    await ui.input({ key: 'edit', text: 'Nova.', kind: 'change' })
    expect(host.files.get('spec.md')).toContain('Postgres será o storage.\nNova.\n')
    await ui.input({ key: 'edit', text: 'Nova.' })
    await ui.press({ key: 'delete-line' })
    expect(host.files.get('spec.md')).toBe(original.replace('SQLite', 'Postgres'))

    // Reverting puts the line back as it was.
    await ui.press({ key: 'up' })
    await ui.press({ key: 'edit-insert' })
    await ui.input({ key: 'edit', text: '', kind: 'change' })
    expect(host.files.get('spec.md')).toBe(original.replace('SQLite será o storage.', ''))
    await ui.press({ key: 'edit-cancel' })
    expect(host.files.get('spec.md')).toBe(original.replace('SQLite', 'Postgres'))

    // z walks back, one edit at a time.
    await ui.press({ key: 'undo' })
    await ui.press({ key: 'undo' })
    await ui.press({ key: 'undo' })
    expect(host.files.get('spec.md')).toBe(original)
    await ui.unmount()
  })
}
