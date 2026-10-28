import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const method of ['single', 'batch'] as const) {
  test(`deletes the last active single-chat session via ${method} deletion without creating a replacement`, async ({ page }) => {
    const session = { id: 'last-active', title: 'Last active conversation', source: 'cli', agent: 'hermes', profile: 'default', model: 'test-model', provider: 'test-provider', started_at: 1_800_000_000, message_count: 0 }
    const sessions = [session]
    const deleted: string[] = []
    await authenticate(page)
    await mockChatSocket(page)
    await mockHermesApi(page, { sessions })
    await page.addInitScript(session => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__ = { [session.id]: { session_id: session.id, title: session.title, messages: [], isWorking: false, events: [] } }
    }, session)
    await page.route('**/api/studio/sessions/last-active*', route => {
      if (route.request().method() !== 'DELETE') return route.fallback()
      deleted.push(session.id)
      sessions.splice(0)
      return route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/studio/sessions/batch-delete', route => {
      const body = route.request().postDataJSON()
      deleted.push(...body.ids)
      sessions.splice(0)
      return route.fulfill({ json: { deleted: body.ids.length, failed: 0, errors: [] } })
    })
    await page.goto('/#/hermes/session/last-active')
    await expect(page.locator('.header-session-title')).toHaveText(session.title)
    const sidebar = page.locator('.chat-panel > .session-list')
    if (method === 'single') {
      const row = sidebar.locator('.session-item').filter({ hasText: session.title }).first()
      await row.hover()
      await row.locator('.session-item-delete').click()
    } else {
      await sidebar.getByRole('button', { name: 'Session list actions', exact: true }).click()
      await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
      const toolbar = sidebar.locator('.session-list-toolbar')
      await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
      await expect(toolbar).toContainText('1 selected')
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    }
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(sidebar.locator('.session-item')).toHaveCount(0)
    await expect(sidebar.locator('.session-empty')).toBeVisible()
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    expect(deleted).toEqual([session.id])
    await page.reload()
    await expect(sidebar.locator('.session-empty')).toBeVisible()
    await expect(sidebar.locator('.session-item')).toHaveCount(0)
  })
}
