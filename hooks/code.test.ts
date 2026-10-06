import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, fakeHost } from './fake-host'

const SYNC = [
  'export class BookmarkSyncService {',
  '  async sync(items: string[]) {',
  '    const batch = items.slice(0, 10)',
  '    return batch',
  '  }',
  '}',
  '',
].join('\n')

test('reviews code by line and symbol, and the reviser edits it in place', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { 'src/sync.ts': SYNC })

  await $.command.run(OPEN('src/sync.ts'))
  expect(host.view()).toMatchObject({ file: 'src/sync.ts', syntax: 'code' })
  expect(host.view()!.segments).toHaveLength(1)

  host.page({ kind: 'open', mode: 'comment', text: 'const batch = items.slice(0, 10)', seg: 0, message: 'Use BATCH_SIZE.' })
  await clock.advance(2000)
  expect(host.spawned[0]!.prompt).toContain('The selected passage (L3, in BookmarkSyncService.sync)')

  await $.turn.complete(DONE(host.view()!.threads[0]!.id, 'Feito.', [{ old: 'slice(0, 10)', new: 'slice(0, BATCH_SIZE)' }]))
  expect(host.view()!.hunks).toMatchObject([{ removed: '10', added: 'BATCH_SIZE' }])
  expect(host.files.get('src/sync.ts')).toBe(SYNC)
  host.page({ kind: 'review' })
  await clock.advance(2000)
  expect(host.files.get('src/sync.ts')).toBe(SYNC.replace('slice(0, 10)', 'slice(0, BATCH_SIZE)'))
})
