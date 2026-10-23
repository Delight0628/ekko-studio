import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const task = { id: 'one', session_id: 'task-chat', session_title: 'Studio 会话任务', profile: 'research', source: 'coding_agent', agent: 'codex',
  title: '设计任务展示页面', summary: '接入会话任务，完善桌面与手机列表', status: 'open', updated_at: Date.now(), message_id: 1 }

test('paginates with stable filters and ignores an older search response', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let staleStarted = false
  await page.route('**/api/studio/session-tasks?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('search') === 'older') { staleStarted = true; await gate }
    const offset = Number(query.get('offset'))
    const title = query.get('search') === 'newer' ? 'Newest result' : query.get('search') === 'older' ? 'Stale result' : `Page ${offset / 50 + 1}`
    return route.fulfill({ json: { tasks: [{ ...task, title }], total: 51, has_more: offset === 0 } })
  })
  await page.goto('/#/hermes/tasks?status=open&page=2')
  await expect(page.locator('.task-row')).toContainText('Page 2')
  await page.locator('.n-pagination-item').filter({ hasText: /^1$/ }).click()
  await expect(page).toHaveURL(/taskStatus=open&taskPage=1/)
  await expect(page.locator('.task-row')).toContainText('Page 1')
  await page.getByRole('button', { name: 'Search tasks or conversations' }).click()
  const input = page.getByRole('textbox', { name: 'Search tasks or conversations' })
  await input.fill('older')
  await expect.poll(() => staleStarted).toBe(true)
  await input.fill('newer')
  await expect(page.locator('.task-row')).toContainText('Newest result')
  release()
  await expect(page.locator('.task-row')).toContainText('Newest result')
  await expect(page).not.toHaveURL(/taskPage=/)
})

test('refreshes completion on focus and renders the approved list at desktop and phone widths', async ({ page }) => {
  await authenticate(page)
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await mockHermesApi(page)
  await mockChatSocket(page)
  let completed = false
  await page.route('**/api/studio/session-tasks?**', route => route.fulfill({ json: {
    tasks: [task, { ...task, id: 'two', title: '修复 GitHub 构建失败', summary: '测试与构建已验证通过', status: 'completed' },
      { ...task, id: 'three', title: '接入会话任务记录', summary: '支持一个会话中的多个任务', status: completed ? 'completed' : 'open' }], total: 3, has_more: false,
  } }))
  await page.goto('/#/hermes/tasks')
  await expect(page.locator('.task-row')).toHaveCount(3)
  await page.screenshot({ path: '/tmp/ekko-task-page-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('.task-status').first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(28)
  expect(await page.locator('.mobile-time').first().evaluate(el => el.getBoundingClientRect().height - parseFloat(getComputedStyle(el).paddingTop))).toBeLessThanOrEqual(18)
  await page.screenshot({ path: '/tmp/ekko-task-page-mobile.png' })
  completed = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.task-row--completed')).toHaveCount(2)
  await expect(page.locator('.session-tasks-drawer .studio-navigation-rail, .session-tasks-drawer .page-sidebar')).toHaveCount(0)
})
