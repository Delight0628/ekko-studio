import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi, mockChatSocket, TEST_ACCESS_KEY } from './fixtures'

async function setup(page: Page, brightness = 'light', wallpaper = false, active = true) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessions: any[] = []
  const api = await mockHermesApi(page, { sessions, theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.4 }, regions: { card: { opacity: wallpaper ? 0 : 0.8, blur: 8, radius: 14 }, overlay: { opacity: 0.85 }, input: { opacity: 0.5 } } },
  } })
  if (wallpaper) {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
    await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: png }))
  }
  const types = [{ id: 'qwen', name: 'Qwen Code', configSchema: { type: 'object', required: ['cwd'], additionalProperties: false, properties: {
    cwd: { type: 'string' }, model: { type: 'string' }, env: { type: 'object' }, args: { type: 'array' }, systemPrompt: { type: 'string' }, studioMcp: { type: 'object' },
  } }, capabilities: { text: true, nativeMcp: true, modes: ['scoped', 'global'] }, management: { inspect: true, setup: true } }]
  let instances: any[] = [], conflict = false, failChat = false
  const writes: any[] = [], enables: any[] = [], checks: any[] = [], chatCreations: any[] = []
  await page.route('**/api/studio/agent-types?*', route => route.fulfill({ json: { data: { agents: active ? types : [] } } }))
  await page.route('**/api/studio/bundled-agent-plugins**', async route => {
    const request = route.request()
    if (request.method() === 'POST') { enables.push(request.postDataJSON()); active = true; return route.fulfill({ json: { data: { enabled: true, revision: 1 } } }) }
    return route.fulfill({ json: { data: [{ id: 'qwen', name: 'Qwen Code', pluginId: 'studio.agent-qwen', revision: 0, installed: active, enabled: active, state: active ? 'ready' : 'not_installed', requiredCapabilities: ['agents.register', 'processes.spawn'] }] } })
  })
  await page.route('**/api/studio/agent-instances**', async route => {
    const request = route.request(), url = new URL(request.url())
    expect(url.searchParams.get('profile')).toBe('research')
    if (url.pathname.endsWith('/chats')) {
      const body = request.postDataJSON(), item = instances[0]
      chatCreations.push(body)
      const id = 'managed-chat'
      if (!sessions.length) sessions.push({ id, profile: 'research', source: 'coding_agent', agent: item.agentTypeId, agent_mode: item.mode,
        agent_instance_id: item.id, agent_instance_revision: item.revision, model: item.config.model || '', workspace: item.config.cwd,
        title: 'Managed chat', started_at: 100, last_active: 100, message_count: 0, agent_usage: { inputTokens: null, outputTokens: null } })
      await page.evaluate(({ id, item }) => {
        ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: { session_id: id, messages: [], isWorking: false, events: [], managed_agent_protocol: 1,
          agent_instance_id: item.id, agent_instance_revision: item.revision, agent_mode: item.mode, model: item.config.model || '', workspace: item.config.cwd, agentInteractions: [] } }
      }, { id, item })
      if (failChat) { failChat = false; return route.fulfill({ status: 503, json: { error: { message: 'Temporary response failure' } } }) }
      return route.fulfill({ json: { data: { sessionId: id, instanceId: item.id, profileId: 'research', configurationRevision: body.revision, createdAt: 1 } } })
    }
    if (url.pathname.endsWith('/resources')) return route.fulfill({ json: { data: { instanceId: 'managed', configRevision: instances[0]?.revision, snapshot: 'snapshot', skills: [], configs: [], files: [] } } })
    if (url.pathname.endsWith('/setup')) {
      checks.push(request.postDataJSON())
      return route.fulfill({ json: { data: { cli: { state: 'available', version: '0.25.0' }, installation: { command: 'npm', args: ['install', '--global', '@qwen-code/qwen-code@0.25.0'] },
        authentication: instances[0]?.mode === 'scoped' ? { kind: 'studio' } : { kind: 'native', command: 'qwen', args: [], input: '/auth' } } } })
    }
    if (url.pathname.endsWith('/inspect')) return route.fulfill({ json: { data: { native: { name: 'Qwen Code' }, authentication: { state: 'unknown', methods: [] }, models: { status: 'unsupported', items: [] } } } })
    if (request.method() === 'GET') return route.fulfill({ json: { data: instances } })
    const body = request.postDataJSON()
    if (conflict) return route.fulfill({ status: 409, json: { error: { message: 'Instance changed; reload before saving' } } })
    writes.push(body)
    if (request.method() === 'POST') instances = [{ ...body, id: 'managed', revision: 1 }]
    else { expect(body.revision).toBe(instances[0].revision); instances = [{ ...instances[0], ...body, revision: body.revision + 1 }] }
    return route.fulfill({ json: { data: instances[0] } })
  })
  return { ...api, writes, enables, checks, chatCreations, instances: () => instances, conflict: () => { conflict = true }, failChat: () => { failChat = true } }
}

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) test(`creates and updates an instance with themed forms (${brightness}, wallpaper ${wallpaper})`, async ({ page }, info) => {
  if (wallpaper) await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, brightness, wallpaper)
  await page.goto('/#/studio/agents/qwen/settings')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible')
  await expect(modal.getByLabel('cwd', { exact: true })).toBeVisible()
  expect((await modal.boundingBox())!.width).toBeLessThanOrEqual(720)
  await modal.getByLabel('cwd', { exact: true }).fill('/workspace with spaces')
  await modal.getByLabel('env', { exact: true }).fill('invalid-json')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(modal.getByText('Invalid or missing value: env', { exact: true })).toBeVisible()
  expect(api.writes).toEqual([])
  await modal.getByLabel('env', { exact: true }).fill('{"QWEN_HOME":"/native-home"}')
  await modal.getByLabel('args', { exact: true }).fill('["literal argument"]')
  await modal.getByLabel('studioMcp', { exact: true }).fill('{"enabled":true,"browser":false}')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/instance=managed/)
  expect(api.writes[0]).toEqual({ agentTypeId: 'qwen', mode: 'scoped', config: { cwd: '/workspace with spaces', env: { QWEN_HOME: '/native-home' }, args: ['literal argument'], studioMcp: { enabled: true, browser: false } } })
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  await expect(modal.getByLabel('studioMcp', { exact: true })).toHaveValue(/"enabled": true/)
  await modal.getByLabel('studioMcp', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('native-mcp-config.png') })
  await modal.getByRole('button', { name: 'Check installation and login', exact: true }).click()
  await expect(modal.getByText('CLI available', { exact: false })).toBeVisible()
  await expect(modal.getByText('Native login', { exact: true })).toHaveCount(0)
  await modal.getByLabel('Mode', { exact: true }).click()
  await page.getByText('Native account', { exact: true }).click()
  await modal.getByLabel('model', { exact: true }).fill('new-native-model')
  await expect(modal.getByRole('button', { name: 'Check installation and login', exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('instance-form.png') })
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal).toBeHidden()
  expect(api.writes[1]).toMatchObject({ revision: 1, mode: 'global', config: { model: 'new-native-model', env: { QWEN_HOME: '/native-home' } } })
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  await modal.getByRole('button', { name: 'Check installation and login', exact: true }).click()
  await expect(modal.getByText('Native login', { exact: true })).toBeVisible()
  await expect(modal.getByText('Verified authentication state: Unknown', { exact: true })).toBeVisible()
  await expect(modal.locator('.native-setup')).toContainText('/auth')
  await modal.locator('.native-setup').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('native-setup.png') })
  expect(api.checks).toEqual([{ revision: 1 }, { revision: 2 }])
  expect(api.unexpectedRequests).toEqual([])
})

test('explicitly enables an implemented bundled plugin before creating instances', async ({ page }) => {
  const api = await setup(page, 'light', false, false)
  await page.goto('/#/studio/agents')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible')
  await expect(modal.getByText('agents.register, processes.spawn', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'Authorize and enable', exact: true }).click()
  await expect(modal.getByLabel('cwd', { exact: true })).toBeVisible()
  await modal.getByLabel('cwd', { exact: true }).fill('/workspace')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/studio\/agents\/qwen\/settings\?instance=managed/)
  expect(api.enables).toEqual([{ revision: 0, grants: ['agents.register', 'processes.spawn'] }])
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps the configuration draft when a concurrent revision prevents saving', async ({ page }) => {
  const api = await setup(page)
  await page.goto('/#/studio/agents/qwen/settings')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible')
  await modal.getByLabel('cwd', { exact: true }).fill('/workspace')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/instance=managed/)
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  await modal.getByLabel('systemPrompt', { exact: true }).fill('Keep this draft')
  api.conflict()
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert').filter({ hasText: 'Instance changed; reload before saving' })).toBeVisible()
  await expect(modal.getByLabel('systemPrompt', { exact: true })).toHaveValue('Keep this draft')
  expect(api.instances()[0].revision).toBe(1)
})

for (const mobile of [false, true]) test(`opens an instance chat with images, restored approvals and an idempotent retry (${mobile ? 'mobile dark' : 'desktop light'})`, async ({ page }, info) => {
  if (mobile) await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined }))
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  const api = await setup(page, mobile ? 'dark' : 'light', mobile)
  await mockChatSocket(page)
  await page.goto('/#/studio/agents/qwen/settings')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible')
  await modal.getByLabel('cwd', { exact: true }).fill('/owned workspace')
  await modal.getByLabel('model', { exact: true }).fill('instance-model')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/instance=managed/)
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  api.failChat()
  await modal.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(modal.getByRole('alert').filter({ hasText: 'Temporary response failure' })).toBeVisible()
  await modal.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page).toHaveURL(/\/hermes\/session\/managed-chat\?profile=research/)
  expect(api.chatCreations).toEqual([{ revision: 1, idempotencyKey: expect.any(String) }, { revision: 1, idempotencyKey: api.chatCreations[0].idempotencyKey }])
  await expect(page.locator('.chat-input-area .input-model-button')).toHaveText('instance-model')
  await expect(page.locator('.chat-input-area .input-model-button')).toBeDisabled()
  await expect(page.locator('.reasoning-effort-button')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Set Workspace', exact: true })).toBeDisabled()
  const input = page.locator('.chat-input-area textarea')
  await input.fill('/status')
  await expect(page.locator('.slash-command-dropdown:visible')).toHaveCount(0)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload))
    .toEqual({ session_id: 'managed-chat', profile: 'research', input: '/status', queue_id: expect.any(String), push_enabled: false, managed_agent_protocol: 1 })
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__, queueId = state.emitted.filter((item: any) => item.event === 'run').at(-1).payload.queue_id
    const data = { session_id: 'managed-chat', agent_run_id: 'first', run_id: 'first', run_marker: 'first', queue_id: queueId }
    state.broadcast('run.started', { ...data, event: 'run.started' })
    state.broadcast('message.persisted', { ...data, event: 'message.persisted', messages: [
      { id: 1, role: 'user', content: '/status', timestamp: 100, run_marker: 'first' }, { id: 2, role: 'assistant', content: 'Ready.', timestamp: 100, run_marker: 'first' },
    ] })
    state.broadcast('run.completed', { ...data, event: 'run.completed', status: 'completed', queue_remaining: 0 })
  })
  await expect(page.getByText('Ready.', { exact: true })).toHaveCount(1)
  await expect(page.locator('.context-info')).toContainText('—')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#204060' } }).png().toBuffer()
  const imageId = 'ab012345-6789-0123-4567-0123456789ab', imagePath = `agent-artifact:managed-chat/${imageId}`
  const uploads: Buffer[] = []
  await page.route('**/api/studio/agent-images?*', route => {
    expect(route.request().headers()['content-type']).toBe('application/octet-stream')
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    uploads.push(route.request().postDataBuffer()!)
    return route.fulfill({ json: { data: { id: imageId, mediaType: 'image/png', byteLength: png.length } } })
  })
  await page.route('**/api/studio/agent-chats/managed-chat/images/*?*', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.locator('.chat-input-area input[type=file]').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: png })
  await input.fill('Describe this image')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload.input))
    .toEqual([{ type: 'text', text: 'Describe this image' }, { type: 'image', name: 'picture.png', media_type: 'image/png', path: imagePath }])
  expect(uploads).toHaveLength(1)
  expect(uploads[0].equals(png)).toBe(true)
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    state.broadcast('run.started', { event: 'run.started', session_id: 'managed-chat', agent_run_id: 'image-run', run_marker: 'image-run' })
    state.broadcast('message.persisted', { event: 'message.persisted', session_id: 'managed-chat', agent_run_id: 'first', run_marker: 'first', replayed: true, terminal: true,
      messages: [{ id: 2, role: 'assistant', content: 'Ready. (replayed)', timestamp: 100, run_marker: 'first' }] })
    state.broadcast('run.completed', { event: 'run.completed', session_id: 'managed-chat', agent_run_id: 'first', run_marker: 'first', replayed: true, queue_remaining: 1 })
  })
  await expect(page.getByText('Ready. (replayed)', { exact: true })).toHaveCount(1)
  await expect(page.locator('.chat-input-area').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  const messages = [{ id: 3, role: 'user', content: JSON.stringify([{ type: 'text', text: 'Describe this image' }, { type: 'image', name: 'image.png', media_type: 'image/png', path: imagePath }]), timestamp: 101, run_marker: 'image-run' },
    { id: 4, role: 'assistant', content: 'Native picture answer.', timestamp: 101, run_marker: 'image-run' }]
  const interaction = { id: 'approval', requestId: 'native-request', runId: 'image-run', kind: 'approval', prompt: 'Allow native operation?', choices: [{ id: 'allow-native-once', label: 'Allow once' }], status: 'pending', expiresAt: null }
  await page.addInitScript(({ messages, interaction }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'managed-chat': { session_id: 'managed-chat', managed_agent_protocol: 1,
      agent_instance_id: 'managed', agent_instance_revision: 1, agent_mode: 'scoped', model: 'instance-model', messages, isWorking: true, events: [], agentInteractions: [interaction] } }
  }, { messages, interaction })
  const responses: any[] = []
  await page.route('**/api/studio/agent-runs/image-run/respond?*', route => {
    responses.push(route.request().postDataJSON())
    return route.fulfill({ json: { data: { id: 'approval', runId: 'image-run', status: 'resolved' } } })
  })
  await page.reload()
  await expect(page.getByText('Native picture answer.', { exact: true })).toHaveCount(1)
  const image = page.locator(`img[src*="/agent-chats/managed-chat/images/${imageId}"]`)
  await expect(image).toHaveCount(1)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
  await expect(page.getByText('Allow native operation?', { exact: true })).toBeVisible()
  await expect(page.getByText('Review tool call before running', { exact: true })).toBeVisible()
  await expect(page.locator('.approval-float-panel .pending-interaction-countdown')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('managed-chat-image-approval.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1440)
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  expect(responses).toEqual([{ interactionId: 'approval', choiceId: 'allow-native-once', idempotencyKey: expect.any(String) }])
  expect(api.checks).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})
