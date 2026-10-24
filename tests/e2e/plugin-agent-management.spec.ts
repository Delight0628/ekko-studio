import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function setup(page: Page, brightness = 'light', wallpaper = false, active = true) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { theme: { brightness,
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
  let instances: any[] = [], conflict = false
  const writes: any[] = [], enables: any[] = [], checks: any[] = []
  await page.route('**/api/studio/agent-types?*', route => route.fulfill({ json: { data: { agents: active ? types : [] } } }))
  await page.route('**/api/studio/bundled-agent-plugins**', async route => {
    const request = route.request()
    if (request.method() === 'POST') { enables.push(request.postDataJSON()); active = true; return route.fulfill({ json: { data: { enabled: true, revision: 1 } } }) }
    return route.fulfill({ json: { data: [{ id: 'qwen', name: 'Qwen Code', pluginId: 'studio.agent-qwen', revision: 0, installed: active, enabled: active, state: active ? 'ready' : 'not_installed', requiredCapabilities: ['agents.register', 'processes.spawn'] }] } })
  })
  await page.route('**/api/studio/agent-instances**', async route => {
    const request = route.request(), url = new URL(request.url())
    expect(url.searchParams.get('profile')).toBe('research')
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
  return { ...api, writes, enables, checks, instances: () => instances, conflict: () => { conflict = true } }
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
  await modal.getByRole('button', { name: 'Enable plugin', exact: true }).click()
  await expect(modal.getByLabel('cwd', { exact: true })).toBeVisible()
  await modal.getByLabel('cwd', { exact: true }).fill('/workspace')
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/studio\/agents\/qwen\/settings\?instance=managed/)
  expect(api.enables).toEqual([{ revision: 0 }])
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
