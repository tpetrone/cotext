import { expect, test } from 'claude-code/testing'

import { OPEN, PANE, fakeHost } from './fake-host'

const SYNC = [
  'export class BookmarkSyncService {',
  '  async sync(items: string[]) {',
  '    const batch = items.slice(0, 10)',
  '    return batch',
  '  }',
  '}',
  '',
].join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`reviews code by line and symbol, across files, on ${surface}`, async ($, on) => {
    const host = fakeHost(on, { 'src/sync.ts': SYNC, 'spec.md': '# Spec\n\nUse batches.\n' })

    // A Markdown annotation first, so the project scope has two files.
    await $.command.run(OPEN('spec.md'))
    const ui = await $.ui.mount({ plugin: 'cotext', surface, ...PANE })
    host.select('Use batches.')
    await ui.press({ key: 'highlight' })

    await $.command.run(OPEN('src/sync.ts'))
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"startLine":1')

    // The gutter's numbers ride along with a selection in a code view.
    host.select('3     const batch = items.slice(0, 10)')
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'note', text: 'Why 10?' })
    expect(host.saved()[1]!.anchor).toMatchObject({
      lineStart: 3,
      symbol: 'BookmarkSyncService.sync',
      selectedText: 'const batch = items.slice(0, 10)',
    })

    await ui.press({ key: 'send-review' })
    expect(host.submitted[0]).toContain('src/sync.ts')
    expect(host.submitted[0]).not.toContain('spec.md')
    expect(host.submitted[0]).toContain('ANNOTATION 1: reject (L3, in BookmarkSyncService.sync)')
    await $.turn.start({ text: host.submitted[0]!, turnId: 't3' })
    await $.turn.complete({ turnId: 't3', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

    await ui.press({ key: 'scope' })
    expect(await ui.find({ key: 'send-review', text: 'Review project' })).toBeDefined()
    await ui.press({ key: 'send-review' })
    expect(host.submitted[1]).toContain('## spec.md')
    expect(host.submitted[1]).toContain('## src/sync.ts')
    await ui.unmount()
  })
}
