import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'
import sharp from 'sharp'

async function setup(page: Page, mode: 'light' | 'dark', wallpaper = true) {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, { theme: { brightness: mode, ...(wallpaper ? { background: { name: 'person.png', mime: 'image/png', updatedAt: 1 } } : {}), appearance: { global: { opacity: 0.5 }, regions: { card: { opacity: 0.65, blur: 12 } } } } })
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#345678' } }).png().toBuffer()
  await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
  const globalModel = { model: 'global-model', provider: 'provider', profile: 'default' }
  const state: any = { settings: { model: globalModel, reasoningEffort: '', timezone: 'UTC', agents: [] }, inherits_global_model: true, reasoning_efforts: ['none', 'low', 'high'], revision: 0, busy: false, tasks: [{ id: 'task1', title: 'Check report', summary: 'Verify a report', status: 'open', revision: 0, execution_id: 'execution1', execution_state: 'running', running: true }], schedules: [], memories: [], interactions: [] }
  state.session = { id: 'person-main-1', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', profile: 'default', title: 'Person', model: 'global-model', provider: 'provider', started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '' }
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'person-main-1': { session_id: 'person-main-1', messages: [], isWorking: false, events: [] } } })
  const operations: any[] = []
  await page.route(/^https?:\/\/[^/]+\/api\/studio\/person(?:\/|\?|$)/, async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; const body = req.postDataJSON()
    operations.push({ path, body, headers: req.headers() })
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { agents: [{ runtime: 'ekko', installed: true }, { runtime: 'codex', installed: true }], native_allowed: true } })
    if (path.endsWith('/models') || path.endsWith('/agent-models')) return route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: 'My provider', models: ['global-model', 'fast-model'], model_meta: { 'global-model': { reasoning_efforts: ['none', 'low', 'high'] }, 'fast-model': { reasoning: false } } }] } })
    if (path.endsWith('/settings')) {
      if (body.expected_revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Settings changed' } })
      if (body.agents) state.settings.agents = body.agents
      if (body.model) { state.settings.model = body.model; state.inherits_global_model = false; state.reasoning_efforts = []; state.settings.reasoningEffort = '' }
      if (body.reasoning_effort !== undefined) state.settings.reasoningEffort = body.reasoning_effort
      if (body.use_global_default) { state.settings.model = globalModel; state.inherits_global_model = true; state.reasoning_efforts = ['none', 'low', 'high'] }
      state.revision++
      return route.fulfill({ json: { settings: state.settings, revision: state.revision, inherits_global_model: state.inherits_global_model, reasoning_efforts: state.reasoning_efforts } })
    }
    if (path.endsWith('/tasks/task1/chat')) {
      if (req.method() === 'POST') { state.tasks[0].running = true; state.tasks[0].status = 'open'; state.tasks[0].execution_state = 'queued'; state.tasks[0].execution_id = 'execution2'; state.tasks[0].revision++ }
      return route.fulfill({ json: { task: state.tasks[0], session: { ...state.session, id: 'person-task-task1', title: state.tasks[0].title } } })
    }
    if (path.endsWith('/tasks/apply')) {
      if (body.expected_revision !== state.tasks[0].revision || (body.action === 'stop' && body.execution_id !== state.tasks[0].execution_id)) return route.fulfill({ status: 409, json: { error: 'Execution changed' } })
      if (body.action === 'stop') state.tasks[0].execution_state = 'stopping'
      else state.tasks[0].status = body.action === 'close' ? 'closed' : 'open'
      state.tasks[0].revision++
      return route.fulfill({ json: { task: state.tasks[0] } })
    }
    if (path.endsWith('/memory')) { state.memories = state.memories.filter((m: any) => m.id !== body.id); return route.fulfill({ json: {} }) }
    state.session.model = state.settings.model?.model || ''; state.session.provider = state.settings.model?.provider || ''; state.session.reasoning_effort = state.settings.reasoningEffort
    return route.fulfill({ json: state })
  })
  return { state, operations }
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person reuses single chat controls, inherits defaults and switches models in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    await page.goto('/#/person')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')
    await expect(page.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0)
    await expect(input).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-empty.png`, animations: 'disabled' })
    await page.locator('.reasoning-effort-button').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', '2')
    await slider.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
    await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
    await page.keyboard.press('Escape')
    await input.fill('Check the report')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === 'run').length)).toBe(1)
    const run = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((e: any) => e.event === 'run').payload)
    expect(run).toMatchObject({ session_id: 'person-main-1', agent_id: 'ekko-agent', model: 'global-model', reasoning_effort: 'high' })
    await emit(page, 'run.started', { run_id: 'person-run' })
    await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', '/person/thinking.gif')
    await expect.poll(() => page.locator('.thinking-avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await emit(page, 'reasoning.delta', { delta: 'Checking the task requirements.' })
    await expect(page.locator('.live-reasoning-detail')).toContainText('Checking the task requirements.')
    await page.mouse.move(600, 30)
    await page.locator('.thinking-avatar').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/person-animation-thinking-${mode}.png`, animations: 'disabled' })
    await emit(page, 'tool.started', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', arguments: {} })
    await expect(page.locator('.tool-call-name').filter({ hasText: 'bot_tasks_query' })).toBeVisible()
    await emit(page, 'tool.completed', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', output: '{"tasks":[]}' })
    await emit(page, 'message.delta', { delta: 'I will follow up on your task.' })
    await emit(page, 'run.completed', { run_id: 'person-run', output: 'I will follow up on your task.' })
    await expect(page.locator('.streaming-indicator .thinking-status')).toHaveCount(0)
    await expect(page.getByText('I will follow up on your task.')).toBeVisible()
    expect(operations.some(op => op.path.endsWith('/chat'))).toBe(false)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.reasoning_effort).toBe('high')
    await page.mouse.move(600, 30)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-desktop.png`, animations: 'disabled' })

    await page.locator('.input-model-button').click()
    const menu = page.locator('.model-cascader:visible')
    await expect(menu).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-models.png`, animations: 'disabled' })
    await menu.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.reload()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.locator('.reasoning-effort-button').click()
    await expect(page.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await page.locator('.input-model-button').click()
    await page.getByRole('button', { name: 'Use global default model', exact: true }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')

    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Running')
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await expect(page.getByRole('button', { name: /^(Pause|Resume|Cancel run|Accept result|Details)$/ })).toHaveCount(0)
    await page.screenshot({ path: `/tmp/person-tasks-${mode}-running.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    state.memories = [{ id: 'saved-memory', revision: 2, content: 'Keep responses short' }]
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toBeVisible()
    await expect(page.getByText('Tell Person what to remember or correct', { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Memory', exact: true })).toHaveCount(0)
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: `/tmp/person-memory-${mode}.png` })
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/memory')).at(-1).body).toEqual({ id: 'saved-memory', expected_revision: 2, forget: true })
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-drawer:visible')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(input).toBeVisible()
    await expect(page.locator('.input-model-button')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-mobile.png`, animations: 'disabled' })
    await page.locator('.input-model-button').click()
    await expect(menu.getByRole('menuitemradio').filter({ hasText: 'global-model' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(operations.every(op => !op.headers['x-hermes-profile'])).toBe(true)
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
  })
}

test('Person replays single-chat questions and uses the same reply, approval and abort events', async ({ page }) => {
  await setup(page, 'light', false)
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
      session_id: 'person-main-1', messages: [{ id: 1, role: 'user', content: 'Check report', timestamp: 1 }], isWorking: true,
      events: [{ event: 'clarify.requested', data: { event: 'clarify.requested', session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', question: 'Which report?', choices: ['Weekly', 'Monthly'], durable: true } }],
    }
  })
  await page.goto('/#/person')
  await expect(page.getByText('Which report?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toHaveCount(1)
  await expect(page.locator('.pending-interaction-countdown:visible')).toHaveCount(0)
  await page.getByRole('button', { name: 'Weekly', exact: true }).click()
  await expect.poll(() => emitted(page, 'clarify.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', response: 'Weekly' })])
  await emit(page, 'clarify.resolved', { clarify_id: 'person-interaction:q:0', resolved: true })
  await emit(page, 'approval.requested', { approval_id: 'person-interaction:a:0', command: 'Publish report', description: 'Allow publishing this report?', choices: ['once','deny'], allow_permanent: false })
  await expect(page.getByText('Allow publishing this report?')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(() => emitted(page, 'approval.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', approval_id: 'person-interaction:a:0', choice: 'once' })])
  await emit(page, 'approval.resolved', { approval_id: 'person-interaction:a:0', resolved: true, choice: 'once' })
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => emitted(page, 'abort')).toEqual([expect.objectContaining({ session_id: 'person-main-1' })])
  await emit(page, 'abort.completed', { synced: true })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  expect(await emitted(page, 'run')).toEqual([])
})

async function emit(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ event, payload }) => (window as any).__PW_CHAT_SOCKET__.broadcast(event, { event, session_id: 'person-main-1', run_id: 'person-run', ...payload }), { event, payload })
}
async function emitted(page: Page, event: string) {
  return page.evaluate(event => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === event).map((e: any) => e.payload), event)
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person navigation follows account presence on desktop and mobile in ${mode}`, async ({ page }) => {
    await setup(page, mode, mode === 'dark')
    await page.goto('/#/person')
    const avatar = page.locator('.studio-navigation-rail__avatar:visible')
    for (const state of ['idle', 'thinking', 'searching', 'done', 'error', 'sleeping']) {
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => String(socket.url).endsWith('/person-presence')))).toBe(true)
      await page.evaluate(state => {
        const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => String(socket.url).endsWith('/person-presence'))
        socket.__trigger('person.presence', { state, lastActivityAt: 1, sleepAt: 600001 })
      }, state)
      await expect(avatar).toHaveAttribute('src', `/person/${state}.gif`)
      await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      await page.screenshot({ path: `/tmp/person-animation-${mode}-${state}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer')).toBeVisible()
    await expect(avatar).toBeInViewport()
    await expect(avatar).toHaveAttribute('src', '/person/sleeping.gif')
    await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await page.screenshot({ path: `/tmp/person-animation-${mode}-mobile.png`, animations: 'disabled' })
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((event: any) => event.event === 'person.activity'))).toBe(true)
    await page.getByRole('link', { name: 'Your account assistant', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer')).not.toBeVisible()
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person shows a durable task return card above usage and opens the task drawer in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode, mode === 'dark')
    state.tasks[0].running = false
    state.tasks[0].status = 'completed'
    state.tasks[0].execution_state = 'finished'
    const summary = 'Verify the report against the original source material.\nInclude a concise explanation of the findings, supporting evidence and any remaining questions so the user can review the full result.'
    const agent = mode === 'light' ? 'codex' : 'ekko'
    state.tasks[0].summary = summary
    state.tasks[0].selection_json = JSON.stringify({ runtime: agent })
    const receipt = { taskId: 'task1', executionId: 'execution1', assistantMessageId: '42', title: 'Check report', summary, agent, state: 'finished' }
    const usage = { runId: 'return-run', assistantMessageId: '42', inputTokens: 120, outputTokens: 35, isEstimated: false }
    await page.goto('/#/person')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await emit(page, 'run.started', { run_id: 'return-run', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'return-run', delta: 'Your report is ready.' })
    await emit(page, 'run.completed', { run_id: 'return-run', message_id: '42', output: 'Your report is ready.', person_task_return: receipt, run_usage: usage })
    const card = page.locator('.person-task-return-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('status')).toHaveText('Completed')
    await expect(card.getByRole('img', { name: mode === 'light' ? 'Codex' : 'Ekko' })).toBeVisible()
    await expect(card).toContainText('Check report')
    expect(await card.evaluate(element => element.nextElementSibling?.classList.contains('run-usage-card'))).toBe(true)
    await page.addInitScript(({ receipt, usage }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
        session_id: 'person-main-1', isWorking: false, events: [], messages: [
          { id: 40, role: 'assistant', content: 'Unrelated reply', timestamp: 1 },
          { id: 42, role: 'assistant', content: 'Your report is ready.', timestamp: 2, person_task_return: receipt, run_usage: usage },
        ],
      }
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = {
        session_id: 'person-task-task1', isWorking: false, events: [], messages: [{ id: 50, role: 'assistant', content: 'Task output', timestamp: 1 }],
      }
    }, { receipt, usage })
    await page.reload()
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    expect(await card.evaluate(element => element.nextElementSibling?.classList.contains('run-usage-card'))).toBe(true)
    await page.locator('.person-compose .input-textarea').fill('Keep draft')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}.png`, animations: 'disabled' })
    const details = card.locator('details')
    await expect(details).not.toHaveAttribute('open')
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await expect(page.locator('.person-task-chat')).toHaveCount(0)
    expect(await card.locator('.task-return-description').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-expanded.png`, animations: 'disabled' })
    await details.locator('summary').click()
    await expect(details).not.toHaveAttribute('open')
    const tagStyle = await card.getByRole('status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    expect(await page.locator('.status-cell .task-status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })).toEqual(tagStyle)
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    const drawer = page.locator('.person-task-chat')
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
    await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep draft')
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-mobile.png`, animations: 'disabled' })
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
  })
}

test('Person offers model selection when the global default is unavailable', async ({ page }) => {
  const { state } = await setup(page, 'dark', false)
  state.settings.model = null; state.reasoning_efforts = []
  await page.goto('/#/person')
  await page.screenshot({ path: '/tmp/person-chat-dark-preset.png', animations: 'disabled' })
  await page.locator('.input-textarea').fill('Hello')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Global default model is unavailable. Choose a model.' }).click()
  await page.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})


test('Person saves agent presets, preserves unsaved edits and only offers opening or closing idle tasks', async ({ page }) => {
  const { state, operations } = await setup(page, 'light')
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText('With no presets, tasks use Ekko', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('textbox', { name: 'Agent name', exact: true }).fill('Research assistant')
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Research and write reports')
  await emit(page, 'person.updated', {})
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.locator('.person-agent-settings .n-select').first().click()
  await page.locator('.n-base-select-option__content:visible').getByText('Codex', { exact: true }).click()
  await page.locator('.person-agent-settings .scoped-model-selector button').click()
  await page.getByRole('menuitemradio').filter({ hasText: 'global-model' }).click()
  await page.locator('.person-agent-settings .n-select').last().click()
  await page.locator('.n-base-select-option__content:visible').getByText('High', { exact: true }).click()
  state.revision++ // Another window changed settings; keep the draft retryable.
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.person-agent-settings .n-alert')).toContainText('Settings changed')
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(1)
  expect(state.settings.agents[0]).toMatchObject({ name: 'Research assistant', description: 'Research and write reports', selection: { runtime: 'codex', mode: 'scoped', provider: 'provider', model: 'global-model', reasoningEffort: 'high' } })
  await page.screenshot({ path: '/tmp/person-agent-settings.png', animations: 'disabled' })
  await page.reload()
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-agent-settings-mobile.png', animations: 'disabled' })
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(0)
  Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
  await emit(page, 'person.updated', {})
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Completed')
  await expect(page.getByRole('button', { name: 'Accept result', exact: true })).toHaveCount(0)
  const status = page.locator('.task-row button[aria-haspopup=menu]:visible')
  await status.click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Closed')
  await status.click()
  await page.getByRole('menuitem', { name: 'Incomplete', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Open')
  await page.screenshot({ path: '/tmp/person-tasks-mobile.png', animations: 'disabled' })
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body.action)).toEqual(['close', 'reopen'])
})

for (const scenario of ['after-request', 'reconnect', 'idle-schedule'] as const) {
  test(`Person streams a background result to the main window (${scenario})`, async ({ page }) => {
    const { state, operations } = await setup(page, 'light', false)
    if (scenario === 'reconnect') {
      await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
    }
    await page.goto('/#/person')
    const input = page.locator('.input-textarea')
    await expect(input).toBeVisible()
    if (scenario === 'after-request') {
      await input.fill('Check Xiamen weather')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await emit(page, 'run.started', { run_id: 'foreground' })
      await emit(page, 'message.delta', { run_id: 'foreground', delta: 'I have started the background task.' })
      await page.evaluate(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
      await emit(page, 'run.completed', { run_id: 'foreground', output: 'I have started the background task.', background_pending: 1 })
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    }
    await emit(page, 'run.started', { run_id: 'callback', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'callback', delta: 'Xiamen is sunny, 25°C.' })
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toBeVisible()
    await emit(page, 'run.completed', { run_id: 'callback', output: 'Xiamen is sunny, 25°C.', autonomous: true, background_pending: 0 })
    Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
    await emit(page, 'person.updated', {})
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Completed')
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
    if (scenario === 'after-request') await page.screenshot({ path: '/tmp/person-background-return.png', animations: 'disabled' })
  })
}

test('opens a hidden task in a right drawer, continues it and restores the Person window', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished', updated_at: Date.now() })
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [
      { id: 'previous-user', role: 'user', content: 'Remember report code LIME-42', timestamp: 1 },
      { id: 'previous-answer', role: 'assistant', content: 'Saved report code LIME-42.', timestamp: 2 },
    ], isWorking: false, events: [] }
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 'main-answer', role: 'assistant', content: 'The report task has finished.', timestamp: 1 }]
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my main conversation draft')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.task-list')).toBeVisible()
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const dialog = page.locator('.person-task-chat')
  await expect(dialog.getByText('Saved report code LIME-42.', { exact: true })).toBeVisible()
  await expect(page.locator('.n-modal')).toHaveCount(0)
  const bounds = await dialog.boundingBox()
  expect(bounds?.y).toBeLessThanOrEqual(48)
  expect(bounds?.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 48)
  expect(bounds && Math.round(bounds.x + bounds.width)).toBe(page.viewportSize()!.width)
  await expect(page.locator('.person-compose')).toHaveCount(1)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.locator('.person-view').getByText('The report task has finished.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
  await dialog.locator('.input-textarea').fill('What code did I give you?')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ input: [{ type: 'text', text: 'What code did I give you?' }], expected_revision: 0 })
  expect(await emitted(page, 'run')).toEqual([])
  await emit(page, 'run.started', { session_id: 'person-task-task1', run_id: 'task-followup' })
  await emit(page, 'message.delta', { session_id: 'person-task-task1', run_id: 'task-followup', delta: 'Your code was LIME-42.' })
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await page.screenshot({ path: '/tmp/person-task-chat-desktop.png', animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-task-chat-mobile.png', animations: 'disabled' })
  await emit(page, 'run.started', { run_id: 'return-to-main', autonomous: true })
  await emit(page, 'message.delta', { run_id: 'return-to-main', delta: 'The follow-up result is LIME-42.' })
  await emit(page, 'run.completed', { run_id: 'return-to-main', output: 'The follow-up result is LIME-42.', background_pending: 0 })
  await expect(page.locator('.person-view').getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('The follow-up result is LIME-42.', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()

})


test('Person uses the single-chat task drawer with search and filters but no pagination controls', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark', false)
  state.tasks = Array.from({ length: 60 }, (_, i) => ({ ...state.tasks[0], id: `task${i}`, title: `Report ${i + 1}`, updated_at: Date.now() - i * 1000, running: false, execution_state: 'finished', status: 'completed' }))
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.session-tasks-drawer .task-row')).toHaveCount(60)
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  expect(operations.find(op => op.path.endsWith('/tasks/query')).body.limit).toBe(100)
  await page.getByRole('button', { name: 'Filter task status' }).click()
  await page.getByRole('menuitem', { name: 'Completed', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.status).toBe('completed')
  await page.getByRole('button', { name: 'Search tasks or conversations' }).click()
  await page.getByRole('textbox', { name: 'Search tasks or conversations' }).fill('Report 60')
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.search).toBe('Report 60')
})

for (const mode of ['light', 'dark'] as const) {
  test(`stops a Person task from the list and waits for acknowledgement in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'Stop task', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-stop-list-${mode}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    await expect(page.locator('[role=status]:visible')).toContainText('Interrupted')
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeEnabled()
    expect(await emitted(page, 'abort')).toEqual([])
  })
}

test('stops a waiting task inside its conversation, then continues it without stopping Person', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].execution_state = 'waiting_user'
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: false, events: [] }
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my draft')
  await emit(page, 'run.started', { run_id: 'main-active' })
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const drawer = page.locator('.person-task-chat')
  await drawer.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
  await page.screenshot({ path: '/tmp/person-stop-chat-mobile.png' })
  Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
  await emit(page, 'person.updated', {})
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
  await drawer.locator('.input-textarea').fill('Continue from the saved result')
  await drawer.getByRole('button', { name: 'Send', exact: true }).click()
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body.expected_revision).toBe(1)
  await expect(drawer.getByRole('button', { name: 'Stop task', exact: true })).toBeEnabled()
  expect(await emitted(page, 'abort')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my draft')
  await emit(page, 'message.delta', { run_id: 'main-active', delta: 'Person is still responding.' })
  await expect(page.locator('.person-view').getByText('Person is still responding.', { exact: true })).toBeVisible()
})

test('refreshes a stale stop without automatically cancelling a newer execution', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible()
  Object.assign(state.tasks[0], { execution_id: 'execution2', revision: 2 })
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByText('Could not update task status. Refresh and try again.')).toBeVisible()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply'))).toHaveLength(1)
  expect(state.tasks[0].execution_state).toBe('running')
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).at(-1).body).toMatchObject({ execution_id: 'execution2', expected_revision: 2 })
})

for (const executionState of ['running', 'queued', 'waiting_user'] as const) {
  test(`stops ${executionState} Person work from the composer with a saved draft`, async ({ page }) => {
    const { state, operations } = await setup(page, executionState === 'queued' ? 'dark' : 'light', false)
    state.tasks[0].execution_state = executionState
    if (executionState !== 'running') await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(({ streaming }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: streaming, events: [] }
    }, { streaming: executionState === 'running' })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
    const drawer = page.locator('.person-task-chat')
    const composer = drawer.locator('.input-textarea')
    await composer.fill('Keep this follow-up draft')
    const stop = drawer.locator('.input-actions').getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeEnabled()
    await composer.press('Enter')
    expect(operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body)).toHaveLength(0)
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-composer-stop-${executionState}.png` })
    await stop.click()
    await expect(stop).toBeDisabled()
    await expect(stop).toHaveAttribute('aria-busy', 'true')
    await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    expect(await emitted(page, 'abort')).toEqual([])
    await emit(page, 'run.failed', { session_id: 'person-task-task1', error: 'Person task stopped' })
    // The socket ending alone cannot restore Send before the durable stop acknowledgement.
    await expect(stop).toBeDisabled()
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    const send = drawer.locator('.input-actions').getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    await send.click()
    await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
    expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ expected_revision: 1, input: [{ type: 'text', text: 'Keep this follow-up draft' }] })
  })
}
