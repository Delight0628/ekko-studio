import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function setup(page: Page, brightness = 'light', wallpaper = false) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.6 }, regions: { card: { opacity: wallpaper ? 0 : 0.8, blur: 8, radius: 12 }, input: { opacity: 0.5 }, overlay: { opacity: 0.85 } } },
  } })
  let revision = 1, fail = false, empty = false
  const calls: any[] = []
  const values = new Map([['first/native/', '{"theme":"light"}'], ['first/workspace/', '# Workspace instructions'], ['first/local/same/SKILL.md', '# Local skill'], ['first/shared/same/SKILL.md', '# Shared skill'], ['second/native/', 'second = true'], ['first/local/same/references/guide.md', '# Skill reference']])
  const instance = (id: string) => ({ id, agentTypeId: id === 'first' ? 'qwen' : 'custom.agent/type', revision, mode: id === 'first' ? 'scoped' : 'global' })
  await page.route('**/api/studio/agent-instances?*', route => route.fulfill({ json: { data: ['first', 'second'].map(instance) } }))
  await page.route('**/api/studio/agent-instances/*/resources?*', async route => {
    const body = route.request().postDataJSON(), id = new URL(route.request().url()).pathname.split('/')[4]
    calls.push({ id, ...body })
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    if (fail) return route.fulfill({ status: 409, json: { error: { message: 'Resource changed; reload before saving' } } })
    const skills = [{ id: 'local', name: 'Native skills', path: '/fixture/local', readOnly: false, scope: 'scoped' }, { id: 'shared', name: 'Shared skills', path: '/fixture/shared', readOnly: true, scope: 'shared' }]
    const configs = [{ id: 'native', name: 'settings.json', path: '/fixture/settings.json', kind: 'file', scope: 'scoped', readOnly: false }, { id: 'workspace', name: 'QWEN.md', path: '/fixture/QWEN.md', kind: 'file', scope: 'workspace', readOnly: true }]
    const files = [
      { kind: 'skills', locationId: 'local', path: 'same/references/guide.md', absolutePath: '/fixture/local/same/references/guide.md', exists: true, readOnly: false },
      { kind: 'configs', locationId: 'native', path: '', absolutePath: '/fixture/settings.json', exists: true, readOnly: false },
      { kind: 'configs', locationId: 'workspace', path: '', absolutePath: '/fixture/QWEN.md', exists: true, readOnly: true },
      ...skills.map(source => ({ kind: 'skills', locationId: source.id, path: 'same/SKILL.md', absolutePath: `${source.path}/same/SKILL.md`, exists: true, readOnly: source.readOnly })),
    ]
    if (body.action === 'list') return route.fulfill({ json: { data: { instanceId: id, configRevision: revision, snapshot: `snapshot-${id}-${revision}`, skills: empty ? [] : skills, configs: empty ? [] : configs, files: empty ? [] : files } } })
    const key = `${id}/${body.locationId}/${body.path}`, entry = files.find(item => item.kind === body.kind && item.locationId === body.locationId && item.path === body.path)!
    expect(entry).toBeTruthy()
    if (body.action === 'write') { expect(body.etag).toBe(`etag-${values.get(key)}`); expect(entry.readOnly).toBe(false); values.set(key, body.content) }
    await route.fulfill({ json: { data: { file: { ...entry, content: values.get(key) || '', etag: `etag-${values.get(key)}` } } } })
  })
  return { ...api, calls, values, fail: (value: boolean) => { fail = value }, empty: () => { empty = true }, revise: () => { revision++ } }
}

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) test(`existing config editor consumes multiple sources (${brightness}, wallpaper ${wallpaper})`, async ({ page }, info) => {
  if (wallpaper) await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, brightness, wallpaper)
  await page.goto('/#/studio/agents/qwen/settings?instance=first')
  const editor = page.locator('.settings-editor-panel textarea')
  await expect(editor).toHaveValue('{"theme":"light"}')
  await editor.fill('{"theme":"dark"}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/native/')).toBe('{"theme":"dark"}')
  await page.getByLabel('Configuration file', { exact: true }).click()
  await page.getByText( 'QWEN.md · /fixture/QWEN.md', { exact: true }).click()
  await expect(editor).toHaveValue('# Workspace instructions')
  await expect(editor).toHaveAttribute('readonly')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await expect(page.locator('.n-message:visible')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('resource-config-readonly.png') })
  await page.getByLabel('Agent instance', { exact: true }).click()
  await page.getByText( 'custom.agent/type · global · second', { exact: true }).click()
  await expect(editor).toHaveValue('second = true')
  await expect(page).toHaveURL(/instance=second/)
  await editor.fill('second = false')
  api.fail(true)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Resource changed; reload before saving')).toBeVisible()
  await expect(editor).toHaveValue('second = false')
  api.fail(false); api.empty()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('No resources at these locations')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('existing Skills editor preserves duplicate sources, saves locally and keeps shared skills read-only', async ({ page }) => {
  const api = await setup(page)
  await page.goto('/#/studio/agents/qwen/skills?instance=first')
  await expect(page.locator('.skill-item')).toHaveCount(2)
  await expect(page.locator('.skill-detail')).toContainText('Local skill')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.skill-detail textarea').fill('# Edited local skill')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/local/same/SKILL.md')).toBe('# Edited local skill')
  await page.getByRole('button', { name: 'references/guide.md', exact: true }).click()
  await expect(page.locator('.skill-detail')).toContainText('Skill reference')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.skill-detail textarea').fill('# Edited reference')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/local/same/references/guide.md')).toBe('# Edited reference')
  await page.locator('.skill-item').nth(1).click()
  await expect(page.locator('.skill-detail')).toContainText('Shared skill')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
  await page.getByTestId('coding-agent-config-settings').click()
  await expect(page).toHaveURL(/settings\?instance=first/)
  await expect(page.locator('.settings-editor-panel textarea')).toHaveValue('{"theme":"light"}')
  expect(api.unexpectedRequests).toEqual([])
})
