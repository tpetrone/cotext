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
  // The approval ends the review, as Encerrar does.
  expect(host.closed).toEqual(['cotext'])
  expect(host.toasts.at(-1)).toBe('cotext: plano aprovado; revisão encerrada.')

  const passed = await $.tool.call({ tool: 'ExitPlanMode' })
  expect(passed.deny).toBeUndefined()
  expect(host.approvals).toEqual([PLAN.replace('SQLite', 'DuckDB')])
  // The release spent the auto-mode choice; the dialog is not answered again.
  expect((await $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: {} })).decision).toBeUndefined()

  // Told what to change in the approval, Claude's next plan is reviewed again.
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toContain(PLAN_PATH)
})

test('Aprovar plano answers the approval as auto mode, once, on the main thread', async ($, on) => {
  const clock = mock.clock(on)
  const host = fakeHost(on, { [PLAN_PATH]: PLAN })
  await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  await $.tool.call({ tool: 'ExitPlanMode' })

  const ask = { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN } }
  expect((await $.classic.PermissionRequest(ask)).decision).toBeUndefined()

  host.page({ kind: 'approvePlan' })
  await clock.advance(2000)

  // A subagent, or another tool, does not spend the choice.
  expect((await $.classic.PermissionRequest({ ...ask, agent_id: 'agent-1' })).decision).toBeUndefined()
  expect((await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })).decision).toBeUndefined()

  // The engine drops an allow that does not carry the call's own input.
  expect((await $.classic.PermissionRequest(ask)).decision).toEqual({
    behavior: 'allow',
    updatedInput: ask.tool_input,
    updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
  })
  expect((await $.classic.PermissionRequest(ask)).decision).toBeUndefined()
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
  expect(host.closed).toEqual([])
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
  expect(host.view()).toMatchObject({ file: 'spec.md', plan: false, hunks: [{ removed: 'A API será REST.\n' }] })
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

const DEFAULT = 'Comece pelo contexto.'

test("plan mode's full reminder carries the plan instructions, the mod's own by default", async ($, on) => {
  fakeHost(on, { [PLAN_PATH]: PLAN, 'defaults/plan-instructions.md': `${DEFAULT}\n` })
  const full = await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))
  expect(full.text).toMatch(/^Plan mode is active\./)
  expect(full.text).toContain('## How to present the plan (cotext, from ')
  expect(full.text).toContain('defaults/plan-instructions.md)\n\nComece pelo contexto.')

  // Between two full ones, a line.
  const sparse = await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH, 'sparse'))
  expect(sparse.text).toMatch(/Present the plan as cotext's instructions/)
  expect(sparse.text).not.toContain(DEFAULT)
})

test("the project's plan instructions come before the person's, the person's before the mod's", async ($, on) => {
  const host = fakeHost(on, {
    [PLAN_PATH]: PLAN,
    'defaults/plan-instructions.md': DEFAULT,
    // The person's, under HOME.
    'plan-instructions.md': 'Do usuário.',
    '.claude/cotext/plan-instructions.md': 'Do projeto.',
  })
  expect((await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))).text).toContain('Do projeto.')

  host.files.delete('.claude/cotext/plan-instructions.md')
  const text = (await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))).text
  expect(text).toContain('from /home/me/.claude/cotext/plan-instructions.md)')
  expect(text).toContain('Do usuário.')

  // An empty file is passed over.
  host.files.set('plan-instructions.md', '  \n')
  expect((await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))).text).toContain(DEFAULT)
})

test('with the /config row off, plan mode reads as the engine wrote it, and the plan is still known', async ($, on) => {
  const host = fakeHost(on, { [PLAN_PATH]: PLAN, 'defaults/plan-instructions.md': DEFAULT })
  host.config.set('cotext.planInstructions', false)

  expect((await $.prompt.attachment(PLAN_REMINDER(PLAN_PATH))).text).toBe(PLAN_REMINDER(PLAN_PATH).text)
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toContain(PLAN_PATH)
})

test("a subagent's plan reminder is left alone", async ($, on) => {
  fakeHost(on, { [PLAN_PATH]: PLAN, 'defaults/plan-instructions.md': DEFAULT })
  const own = await $.prompt.attachment({ ...PLAN_REMINDER(PLAN_PATH), agentId: 'agent-1' })
  expect(own.text).toBe(PLAN_REMINDER(PLAN_PATH).text)
  expect((await $.tool.call({ tool: 'ExitPlanMode' })).deny).toBeUndefined()
})
