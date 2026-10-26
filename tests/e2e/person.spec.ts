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
  const state: any = { settings: { model: globalModel, reasoningEffort: '', timezone: 'UTC' }, inherits_global_model: true, reasoning_efforts: ['none', 'low', 'high'], revision: 0, busy: false, tasks: [{ id: 'task1', title: 'Check report', summary: 'Verify a report', status: 'open', revision: 0, execution_state: 'running' }], schedules: [], memories: [], interactions: [] }
  state.session = { id: 'person-main-1', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', profile: 'default', title: 'Person', model: 'global-model', provider: 'provider', started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '' }
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'person-main-1': { session_id: 'person-main-1', messages: [], isWorking: false, events: [] } } })
  const operations: any[] = []
  await page.route('**/api/studio/person**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; const body = req.postDataJSON()
    operations.push({ path, body, headers: req.headers() })
    if (path.endsWith('/models')) return route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: 'My provider', models: ['global-model', 'fast-model'], model_meta: { 'global-model': { reasoning_efforts: ['none', 'low', 'high'] }, 'fast-model': { reasoning: false } } }] } })
    if (path.endsWith('/settings')) {
      if (body.expected_revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Settings changed' } })
      if (body.model) { state.settings.model = body.model; state.inherits_global_model = false; state.reasoning_efforts = []; state.settings.reasoningEffort = '' }
      if (body.reasoning_effort !== undefined) state.settings.reasoningEffort = body.reasoning_effort
      if (body.use_global_default) { state.settings.model = globalModel; state.inherits_global_model = true; state.reasoning_efforts = ['none', 'low', 'high'] }
      state.revision++
      return route.fulfill({ json: { settings: state.settings, revision: state.revision, inherits_global_model: state.inherits_global_model, reasoning_efforts: state.reasoning_efforts } })
    }
    if (path.endsWith('/tasks/apply')) { state.tasks[0].execution_state = 'stopping'; state.tasks[0].revision++; return route.fulfill({ json: {} }) }
    if (path.endsWith('/memory')) { state.memories = [{ id: 'm1', revision: 0, content: body.content }]; return route.fulfill({ json: {} }) }
    state.session.model = state.settings.model?.model || ''; state.session.provider = state.settings.model?.provider || ''; state.session.reasoning_effort = state.settings.reasoningEffort
    return route.fulfill({ json: state })
  })
  return { state, operations }
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person reuses single chat controls, inherits defaults and switches models in ${mode}`, async ({ page }) => {
    const { operations } = await setup(page, mode)
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
    await emit(page, 'reasoning.delta', { delta: 'Checking the task requirements.' })
    await expect(page.locator('.live-reasoning-detail')).toContainText('Checking the task requirements.')
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
    await expect(page.getByRole('status')).toContainText('Running')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Stopping')
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    await page.getByRole('textbox', { name: 'Memory', exact: true }).fill('Keep responses short')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toBeVisible()
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
    expect(operations.find(op => op.path.endsWith('/tasks/apply')).body).toMatchObject({ action: 'pause', task_id: 'task1', expected_revision: 0 })
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
  await page.evaluate(({ event, payload }) => (window as any).__PW_CHAT_SOCKET__.latest.__trigger(event, { event, session_id: 'person-main-1', run_id: 'person-run', ...payload }), { event, payload })
}
async function emitted(page: Page, event: string) {
  return page.evaluate(event => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === event).map((e: any) => e.payload), event)
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
