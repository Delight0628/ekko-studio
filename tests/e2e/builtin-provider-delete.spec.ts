import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('deletes a built-in in the selected Profile after confirmation and keeps it absent after reload', async ({ page }) => {
  await authenticate(page)
  const provider = {
    provider: 'claude-oauth', label: 'Claude OAuth', builtin: true,
    base_url: 'https://api.anthropic.com', api_key: '', models: ['claude-sonnet-4-6'],
  }
  await mockHermesApi(page, { modelGroups: [provider] })
  let removed = false
  const deletions: Array<{ profile?: string; explicit: string | null }> = []
  await page.route('**/api/hermes/available-models?*', route => route.fulfill({ json: {
    groups: removed ? [] : [provider], allProviders: [provider], default: '', default_provider: '',
  } }))
  await page.route('**/api/hermes/config/providers/claude-oauth?*', async route => {
    deletions.push({ profile: route.request().headers()['x-hermes-profile'],
      explicit: new URL(route.request().url()).searchParams.get('deleteEntry') })
    removed = true
    await route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/hermes/models?modelProfile=research')
  const card = page.locator('.provider-card').filter({ hasText: 'Claude OAuth' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  expect(deletions).toEqual([])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card).toBeVisible()
  expect(deletions).toEqual([])
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(deletions).toEqual([{ profile: 'research', explicit: 'true' }])
  await page.reload()
  await expect(page.getByTestId('models-profile-select')).toContainText('research')
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: 'Add Provider', exact: true }).click()
  await page.getByRole('dialog').locator('.n-base-selection').first().click()
  await expect(page.locator('.n-base-select-option').filter({ hasText: 'Claude OAuth' })).toBeVisible()
})
