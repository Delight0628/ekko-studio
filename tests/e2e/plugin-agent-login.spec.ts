import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function setup(page: Page, brightness = 'light', wallpaper = false, lostInputResponse = false, install: false | 'global' | 'scoped' = false, lostStartResponse = false) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.4 }, regions: { card: { opacity: wallpaper ? 0 : 0.8, blur: 8, radius: 14 }, overlay: { opacity: 0.85 }, input: { opacity: 0.5 } } },
  } })
  if (wallpaper) {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
    await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: png }))
  }
  const instance = { id: 'managed', agentTypeId: 'qwen', revision: 1, mode: install || 'global', config: { cwd: '/workspace' } }
  const starts: any[] = [], inputs: any[] = [], attempts: any[] = [], resizes: any[] = []
  let operation: any = null, lost = lostInputResponse, lostStart = lostStartResponse
  const output = [{ sequence: 1, data: Buffer.from(install ? 'Installing pinned CLI 1.0.0\r\n' : 'Native login 登录\r\nCode: ABCD-1234\r\n').toString('base64') }]
  await page.route('**/api/studio/agent-types?*', route => route.fulfill({ json: { data: { agents: [{ id: 'qwen', name: 'Qwen Code',
    configSchema: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } },
    capabilities: { text: true, modes: ['scoped', 'global'] }, management: { inspect: true, setup: true, prepareLogin: true, ...(install ? { prepareInstall: true } : {}) } }] } } }))
  await page.route('**/api/studio/bundled-agent-plugins?*', route => route.fulfill({ json: { data: [] } }))
  await page.route('**/api/studio/agent-instances**', route => {
    const request = route.request(), url = new URL(request.url())
    expect(url.searchParams.get('profile')).toBe('research')
    if (url.pathname.endsWith('/resources')) return route.fulfill({ json: { data: { instanceId: instance.id, configRevision: 1, snapshot: 'snapshot', skills: [], configs: [], files: [] } } })
    if (url.pathname.endsWith('/operations')) return route.fulfill({ json: { data: operation ? [operation] : [] } })
    if (url.pathname.endsWith('/login') || url.pathname.endsWith('/install')) {
      starts.push(request.postDataJSON())
      operation ||= { id: 'login-operation', instanceId: instance.id, configRevision: 1, provider: { kind: 'plugin', pluginId: 'studio.agent-qwen' }, action: url.pathname.endsWith('/install') ? 'install' : 'login',
        status: 'running', createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 600_000, errorCode: null, exit: null }
      if (lostStart) { lostStart = false; return route.abort('failed') }
      return route.fulfill({ json: { data: operation } })
    }
    if (url.pathname.endsWith('/setup')) return route.fulfill({ json: { data: { cli: { state: 'available', version: '0.25.0' }, installation: { command: 'npm', args: [] }, authentication: { kind: 'native', command: 'qwen', args: [], input: '/auth' } } } })
    if (url.pathname.endsWith('/inspect')) return route.fulfill({ json: { data: { native: { name: 'Qwen Code' }, authentication: { state: 'unknown', methods: [] }, models: { status: 'unsupported', items: [] } } } })
    return route.fulfill({ json: { data: [instance] } })
  })
  await page.route('**/api/studio/agent-management-operations/**', route => {
    const request = route.request(), url = new URL(request.url())
    expect(url.searchParams.get('profile')).toBe('research')
    if (url.pathname.endsWith('/output')) {
      const after = Number(url.searchParams.get('after'))
      return route.fulfill({ json: { data: { chunks: output.filter(chunk => chunk.sequence > after), lastSequence: output.at(-1)!.sequence,
        nextInputSequence: inputs.length + 1, truncated: false, finished: operation.status !== 'running' } } })
    }
    if (url.pathname.endsWith('/input')) {
      const input = request.postDataJSON(); attempts.push(input)
      if (!inputs.some(value => value.sequence === input.sequence)) {
        inputs.push(input); output.push({ sequence: output.length + 1, data: Buffer.from(`Received ${input.text}\r\n`).toString('base64') })
      }
      if (lost) { lost = false; return route.abort('failed') }
      return route.fulfill({ json: { data: { accepted: true } } })
    }
    if (url.pathname.endsWith('/resize')) { resizes.push(request.postDataJSON()); return route.fulfill({ json: { data: { accepted: true } } }) }
    if (url.pathname.endsWith('/cancel')) operation = { ...operation, status: 'cancelled', exit: { code: null, signal: 'SIGTERM' } }
    return route.fulfill({ json: { data: operation } })
  })
  return { ...api, starts, inputs, attempts, resizes }
}

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) test(`opens and reconnects a native login terminal (${brightness}, wallpaper ${wallpaper})`, async ({ page }, info) => {
  if (wallpaper) await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, brightness, wallpaper)
  await page.goto('/#/studio/agents/qwen/settings?instance=managed')
  const open = page.getByRole('button', { name: 'Manage instances', exact: true })
  await open.click()
  const modal = page.locator('.instance-manager-modal:visible')
  await expect(modal.getByRole('button', { name: 'Open login terminal', exact: true })).toBeEnabled()
  expect(api.starts).toEqual([])
  await modal.getByRole('button', { name: 'Open login terminal', exact: true }).click()
  const terminal = modal.getByLabel('Native login terminal', { exact: true })
  await expect(terminal).toBeVisible()
  await expect(terminal).toContainText('ABCD-1234')
  expect(api.starts).toEqual([{ revision: 1, idempotencyKey: expect.any(String) }])
  await expect(modal.getByLabel('cwd', { exact: true })).toBeDisabled()
  await terminal.locator('textarea').focus()
  await terminal.locator('textarea').press('a')
  await expect.poll(() => api.inputs.map(input => input.text).join('')).toBe('a')
  await expect(terminal).toContainText('Received a')
  await expect.poll(() => api.resizes.length).toBeGreaterThan(0)
  await terminal.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('login-terminal.png') })
  const box = await terminal.boundingBox()
  expect(box!.width).toBeGreaterThan(180)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await modal.locator('.n-base-close').click()
  await expect(modal).toBeHidden()
  await open.click()
  await modal.getByRole('button', { name: 'Reconnect terminal', exact: true }).click()
  await expect(terminal).toContainText('Received a')
  await terminal.locator('textarea').focus(); await terminal.locator('textarea').press('b')
  await expect.poll(() => api.inputs).toEqual([{ sequence: 1, text: 'a' }, { sequence: 2, text: 'b' }])
  expect(api.starts).toHaveLength(1)
  await modal.getByRole('button', { name: 'Stop login terminal', exact: true }).click()
  await expect(modal.getByText('Stopped', { exact: true })).toBeVisible()
  await expect(modal.getByText('Verified authentication state: Unknown', { exact: true })).toBeVisible()
  await expect(modal.getByLabel('cwd', { exact: true })).toBeEnabled()
  expect(api.unexpectedRequests).toEqual([])
})

test('retries an uncertain terminal input with the identical sequence and text', async ({ page }) => {
  const api = await setup(page, 'light', false, true)
  await page.goto('/#/studio/agents/qwen/settings?instance=managed')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible')
  await modal.getByRole('button', { name: 'Open login terminal', exact: true }).click()
  const terminal = modal.getByLabel('Native login terminal', { exact: true })
  await expect(terminal).toContainText('ABCD-1234')
  await terminal.locator('textarea').focus(); await terminal.locator('textarea').press('x')
  await expect(modal.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => api.attempts).toEqual([{ sequence: 1, text: 'x' }, { sequence: 1, text: 'x' }])
  expect(api.inputs).toEqual([{ sequence: 1, text: 'x' }])
  await modal.getByRole('button', { name: 'Stop login terminal', exact: true }).click()
  await expect(modal.getByText('Stopped', { exact: true })).toBeVisible()
})

for (const mobile of [false, true]) test(`installs a private CLI with read-only logs and reconnects (${mobile ? 'mobile scoped' : 'desktop native'})`, async ({ page }, info) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, mobile ? 'dark' : 'light', mobile, false, mobile ? 'scoped' : 'global')
  await page.goto('/#/studio/agents/qwen/settings?instance=managed')
  const open = page.getByRole('button', { name: 'Manage instances', exact: true })
  await open.click()
  const modal = page.locator('.instance-manager-modal:visible')
  const install = modal.getByRole('button', { name: 'Install managed CLI', exact: true })
  await expect(install).toBeEnabled()
  expect(api.starts).toEqual([])
  await install.click()
  const log = modal.getByLabel('CLI installation log', { exact: true })
  await expect(log).toContainText('Installing pinned CLI 1.0.0')
  await expect(log).toHaveAttribute('data-readonly', 'true')
  await expect(modal.getByLabel('cwd', { exact: true })).toBeDisabled()
  if (!mobile) await expect(modal.getByRole('button', { name: 'Open login terminal', exact: true })).toBeDisabled()
  await log.locator('textarea').focus()
  await log.locator('textarea').press('a')
  await log.scrollIntoViewIfNeeded()
  await expect(log).toBeInViewport()
  await expect.poll(() => log.evaluate(element => {
    for (let current: Element | null = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) < 1) return false
    return true
  })).toBe(true)
  const logBox = await log.boundingBox(), modalBox = await modal.boundingBox()
  expect(logBox!.x + logBox!.width).toBeLessThanOrEqual(modalBox!.x + modalBox!.width)
  await page.screenshot({ path: info.outputPath('managed-cli-installation-final.png'), animations: 'disabled' })
  await modal.locator('.n-base-close').click()
  await expect(modal).toBeHidden()
  await open.click()
  await modal.getByRole('button', { name: 'View installation log', exact: true }).click()
  await expect(log).toContainText('Installing pinned CLI 1.0.0')
  expect(api.starts).toEqual([{ revision: 1, idempotencyKey: expect.any(String) }])
  expect(api.inputs).toEqual([])
  expect(api.resizes).toEqual([])
  await modal.getByRole('button', { name: 'Cancel installation', exact: true }).click()
  await expect(install).toBeEnabled()
  await expect(modal.getByLabel('cwd', { exact: true })).toBeEnabled()
  expect(api.unexpectedRequests).toEqual([])
})

test('retries a lost installation response using the same request key', async ({ page }) => {
  const api = await setup(page, 'light', false, false, 'global', true)
  await page.goto('/#/studio/agents/qwen/settings?instance=managed')
  await page.getByRole('button', { name: 'Manage instances', exact: true }).click()
  const modal = page.locator('.instance-manager-modal:visible'), install = modal.getByRole('button', { name: 'Install managed CLI', exact: true })
  await install.click()
  await expect.poll(() => api.starts.length).toBe(1)
  await expect(modal.getByRole('alert')).toBeVisible()
  await expect(install).toBeEnabled()
  await install.click()
  await expect(modal.getByLabel('CLI installation log', { exact: true })).toContainText('Installing pinned CLI 1.0.0')
  expect(api.starts).toHaveLength(2)
  expect(api.starts[1]).toEqual(api.starts[0])
  await modal.getByRole('button', { name: 'Cancel installation', exact: true }).click()
  expect(api.inputs).toEqual([])
})
