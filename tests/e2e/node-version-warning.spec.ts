import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const runtime of [
  { version: '24.19.0', kind: 'node', warning: true },
  { version: '24.22.1', kind: 'node', warning: false },
  { version: '24.19.0', kind: 'electron', warning: false },
]) {
  test(`Node version warning for ${runtime.kind} ${runtime.version}`, async ({ page }) => {
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.route('**/health', route => route.fulfill({ json: {
      status: 'ok', node_version: runtime.version, node_runtime: runtime.kind,
    } }))
    await page.goto('/#/hermes/jobs')
    await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
    const warning = page.locator('.node-warning-bar')
    if (runtime.warning) {
      await expect(warning).toHaveText('Detected Node.js v24.19.0. Please use version 24.22.1.')
    } else {
      await expect(warning).toHaveCount(0)
    }
  })
}
