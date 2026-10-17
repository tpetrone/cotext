import { expect, mock, test } from 'claude-code/testing'

import { DONE, OPEN, PLAN_REMINDER, fakeHost } from './fake-host'

const PLAN_PATH = '/home/me/.claude/plans/quiet-plan.md'
const PLAN = ['# Plano', '', 'Usar SQLite como storage.', '', 'Expor uma API REST.', ''].join('\n')
const SPEC = ['# Spec', '', 'A API será REST.', ''].join('\n')

test('ExitPlanMode is held while the plan is reviewed in cotext', async ($, on) => {
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))

  const held = await $.tool.call({ tool: 'ExitPlanMode' })
  expect(held.deny).toContain(PLAN_PATH)
  expect(host.approvals).toEqual([])
  expect(host.view()).toMatchObject({ file: PLAN_PATH, plan: true })
  expect(host.opened).toHaveLength(1)
})

test('Aprovar plano saves the review and lets the next ExitPlanMode through, once', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  await $.tool.call({ tool: 'ExitPlanMode' })

  host.page({ kind: 'open', mode: 'comment', text: 'SQLite', seg: 1, message: 'Prefiro DuckDB.' })
  await clock.advance(2000)
  const id = host.view()!.threads[0]!.id
  await $.turn.complete(DONE(id, 'Troquei.', [{ old: 'SQLite', new: 'DuckDB' }]))

  host.page({ kind: 'approvePlan' })
  await clock.advance(2000)
  expect(host.files.get(PLAN_PATH)).toContain('DuckDB')
  expect(host.prompts.at(-1)!.text).toMatch(/Call ExitPlanMode now/)

  const passed = await $.tool.call({ tool: 'ExitPlanMode' })
  expect(passed.deny).toBeUndefined()
  expect(host.approvals).toEqual([PLAN.replace('SQLite', 'DuckDB')])

  // Told what to change in the approval, Claude's next plan is reviewed again.
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toContain(PLAN_PATH)
})

test('Aprovar plano on a stale draft releases nothing', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  await $.tool.call({ tool: 'ExitPlanMode' })
  host.page({ kind: 'delete', text: 'Expor uma API REST.', seg: 2 })
  await clock.advance(2000)
  host.files.set(PLAN_PATH, PLAN.replace('REST', 'gRPC'))
  await clock.advance(2000)

  host.page({ kind: 'approvePlan' })
  await clock.advance(2000)
  expect(host.toasts.at(-1)).toMatch(/changed on disk since the review began/)
  expect(host.prompts).toEqual([])
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toContain(PLAN_PATH)
})

test('/cotext plan off sends ExitPlanMode straight to its approval', async ($, on) => {
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  expect((await $.command.run(OPEN('plan off'))).text).toMatch(/straight to its approval/)

  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()
  expect(host.approvals).toEqual([PLAN])

  await $.command.run(OPEN('plan on'))
  expect(host.config.get('cotext.reviewPlans')).toBe(true)
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toContain(PLAN_PATH)
})

test('the /config row turned off in the menu counts at the next ExitPlanMode', async ($, on) => {
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  host.config.set('cotext.reviewPlans', false)

  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()
  expect(host.approvals).toEqual([PLAN])
})

test('with no plan known, or its file gone, ExitPlanMode goes through', async ($, on) => {
  const host = fakeHost(on, {})
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()

  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()
  expect(host.approvals).toHaveLength(2)
})

test('another file with unsaved changes is kept: ExitPlanMode goes through', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { [PLAN_PATH]: PLAN, 'spec.md': SPEC })
  await $.command.run(OPEN('spec.md'))
  host.page({ kind: 'delete', text: 'A API será REST.', seg: 1 })
  await clock.advance(2000)
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))

  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()
  expect(host.toasts.at(-1)).toMatch(/spec\.md has unsaved changes/)
  expect(host.view()).toMatchObject({ file: 'spec.md', plan: false, hunks: [{ removed: 'A API será REST.' }] })
})

test('/cotext plan opens the plan, and a file argument still opens that file', async ($, on) => {
  const host = fakeHost(on, { [PLAN_PATH]: PLAN, 'spec.md': SPEC })
  expect((await $.command.run(OPEN('plan'))).text).toBe('No plan in this session yet.')
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))

  expect((await $.command.run(OPEN(''))).text).toBe(`Reviewing the plan ${PLAN_PATH}.`)
  expect(host.view()).toMatchObject({ file: PLAN_PATH, plan: true })

  expect((await $.command.run(OPEN('spec.md'))).text).toBe('Reviewing spec.md.')
  expect(host.view()).toMatchObject({ file: 'spec.md', plan: false })

  expect((await $.command.run(OPEN('plan'))).text).toBe(`Reviewing the plan ${PLAN_PATH}.`)
  expect(host.view()!.file).toBe(PLAN_PATH)
})
