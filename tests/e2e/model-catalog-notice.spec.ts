import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

function provider(id: string, count: number, total = count) {
  const available_models = Array.from({ length: total }, (_, index) => `${id}-model-${index}`)
  return { ...TEST_MODEL_GROUP, provider: id, label: id, models: available_models.slice(0, count), available_models }
}

async function setup(page: Page, groups: ReturnType<typeof provider>[]) {
  await authenticate(page, TEST_ACCESS_KEY)
  const api = await mockHermesApi(page, { modelGroups: groups })
  const visibility: Record<string, { mode: string; models: string[] }> = {}
  const writes: any[] = []
  await page.route('**/api/hermes/model-visibility', async route => {
    const body = route.request().postDataJSON()
    writes.push(body)
    visibility[body.provider] = { mode: body.mode, models: body.models }
    await route.fulfill({ json: { success: true, model_visibility: visibility } })
  })
  await page.route('**/api/hermes/available-models*', async route => {
    const current = groups.map(group => ({
      ...group,
      models: visibility[group.provider]?.mode === 'include' ? visibility[group.provider].models : group.models,
    }))
    await route.fulfill({ json: {
      groups: current, allProviders: groups, default: current[0]?.models[0] || '',
      default_provider: current[0]?.provider || '', model_visibility: visibility,
    } })
  })
  return { api, writes }
}

for (const mobile of [false, true]) {
  test(`large catalogs open the visibility editor and persist the selection (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    const { api, writes } = await setup(page, [provider('Gateway A', 101), provider('Gateway B', 150), provider('Boundary', 100), provider('Filtered', 2, 3000)])
    await page.goto('/#/hermes/models')
    const notice = page.getByTestId('large-model-catalog-notice')
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(2)
    await expect(notice).toContainText('Gateway A: 101 visible models')
    await expect(notice).toContainText('Gateway B: 150 visible models')
    await expect(notice).toContainText('may slow down page loading')
    await page.screenshot({ path: test.info().outputPath('catalog-notice.png'), animations: 'disabled' })
    await notice.locator('li').filter({ hasText: 'Gateway A:' }).getByRole('button', { name: 'Manage visible models' }).click()

    const editor = page.getByRole('dialog').filter({ hasText: 'Manage visible models for Gateway A' })
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await editor.getByRole('checkbox', { name: 'Gateway A-model-100', exact: true }).check()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(writes).toEqual([{ provider: 'Gateway A', mode: 'include', models: ['Gateway A-model-100'] }])
    await expect(notice).toHaveCount(0)

    await page.reload()
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(1)
    await expect(notice).toContainText('Gateway B: 150 visible models')
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    const card = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'Gateway A', exact: true }) })
    await card.getByRole('button', { name: 'Manage visible models', exact: true }).click()
    await expect(editor.getByRole('checkbox', { name: 'Gateway A-model-100', exact: true })).toBeChecked()
    await expect(editor.getByRole('checkbox', { name: 'Gateway A-model-0', exact: true })).not.toBeChecked()
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('100 visible models and a filtered large catalog do not prompt', async ({ page }) => {
  await setup(page, [provider('Boundary', 100), provider('Filtered', 2, 3000)])
  await page.goto('/#/hermes/models')
  await expect(page.getByRole('heading', { name: 'Boundary', exact: true })).toBeVisible()
  await expect(page.getByTestId('large-model-catalog-notice')).toHaveCount(0)
})

test('dismissal lasts for the page visit and another visit shows the reminder again', async ({ page }) => {
  await setup(page, [provider('Gateway', 101)])
  await page.goto('/#/hermes/models')
  const notice = page.getByTestId('large-model-catalog-notice')
  await expect(notice).toBeVisible()
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh model cache', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible()
  await expect(notice).toHaveCount(0)
  await page.goto('/#/hermes/history')
  await expect(page.locator('.models-view')).toHaveCount(0)
  await page.goto('/#/hermes/models')
  await expect(notice).toBeVisible()
})

test('a failed Profile catalog request does not warn about the previous Profile', async ({ page }) => {
  await setup(page, [provider('Gateway', 101)])
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.route('**/api/hermes/available-models?profile=research', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
  await expect(page.getByTestId('models-profile-select')).toContainText('research')
  await expect(page.getByTestId('models-profile-select')).not.toHaveClass(/n-select--disabled/)
  await expect(page.getByTestId('large-model-catalog-notice')).toHaveCount(0)
})
