import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import { BrowserCookieImport } from '../../packages/desktop/src/main/browser/browser-cookie-import'

test('real extension stages a synthetic Chrome cookie for Desktop review', async () => {
  const extension = resolve('extensions/ekko-studio-cookie-import-helper')
  const extensionId = createHash('sha256').update(extension).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)))
  const root = await mkdtemp(join(tmpdir(), 'ekko-extension-test-'))
  const receiver = new BrowserCookieImport()
  const context = await chromium.launchPersistentContext(root, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  try {
    const status = await receiver.start('synthetic-profile')
    await context.addCookies([{
      name: 'session-test', value: 'synthetic-only', domain: '.example.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'Lax',
    }])
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(page.getByRole('heading', { name: 'Ekko Studio Cookie 导入助手' })).toBeVisible()
    await page.locator('#managerUrl').fill(status.managerUrl)
    await page.locator('#token').fill(status.token)
    await page.locator('#scan').click()
    await page.locator('input[type=checkbox][value="example.com"]').check()
    await page.locator('#import').click()
    await expect(page.locator('#status')).toContainText('请回到 Ekko Studio 确认')
    expect(receiver.getStatus()).toMatchObject({ phase: 'review', cookieCount: 1, token: '' })
    const pending = await receiver.take()
    expect(pending.profileId).toBe('synthetic-profile')
    expect(pending.cookies[0]).toMatchObject({ name: 'session-test', value: 'synthetic-only', sameSite: 'lax', httpOnly: true })
    expect(await page.evaluate(async () => {
      return (globalThis as any).chrome.storage.local.get('token')
    })).toEqual({})
  } finally {
    await context.close()
    await receiver.cancel()
    await rm(root, { recursive: true, force: true })
  }
})
