import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import catalog from '../../config/agents.json'
import { selectNewChatAgent } from './new-chat-helpers'
import en from '../../packages/client/src/i18n/locales/en'
import tr from '../../packages/client/src/i18n/locales/tr'
import { mergeMessagesWithFallback } from '../../packages/client/src/i18n/messages'

const messages = { en, tr: mergeMessagesWithFallback(en, tr) as typeof en }

async function openDraft(page: Page, mobile: boolean, locale: 'en' | 'tr' = 'en') {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await page.addInitScript(locale => localStorage.setItem('hermes_locale', locale), locale)
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: catalog.agents.map(agent => ({ id: agent.id, installed: true, source: 'user-cli' })),
  } }))
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: messages[locale].chat.newChat, exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expect(page.locator('.agent-card.active')).toBeVisible()
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
}

for (const locale of ['en', 'tr'] as const) for (const mobile of [false, true]) for (const agent of ['Ekko', 'Codex']) {
  test(`${agent} deployment lands in the thinking avatar (${locale}, ${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(String(error)))
    await openDraft(page, mobile, locale)
    if (agent === 'Codex') await selectNewChatAgent(page, agent)
    // Record geometry through the real route change and live status rendering.
    await page.evaluate(() => {
      const state = { frames: [] as any[], until: performance.now() + 4200 }
      ;(window as any).deploymentFrames = state
      const sample = () => {
        const overlay = document.querySelector<HTMLElement>('.agent-deployment-overlay')
        const hero = overlay?.querySelector<HTMLElement>('.agent-deployment-hero')
        const target = document.querySelector<HTMLElement>('[data-agent-deployment-target]:not([data-agent-deployment-target=""])')
        if (hero && target) {
          const h = hero.getBoundingClientRect(), t = target.getBoundingClientRect()
          state.frames.push({ phase: overlay!.dataset.phase, opacity: hero.style.opacity, targetOpacity: target.style.opacity,
            dx: h.x + h.width / 2 - t.x - t.width / 2, dy: h.y + h.height / 2 - t.y - t.height / 2,
            height: h.height, targetHeight: t.height })
        }
        if (performance.now() < state.until) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.locator('.new-chat-page textarea').fill('Deploy my agent')
    await page.getByRole('button', { name: messages[locale].chat.send, exact: true }).click()
    await expect(page.locator('.agent-deployment-overlay')).toHaveCount(1)
    await expect(page).toHaveURL(/#\/hermes\/session\//)
    const id = new URL(page.url()).hash.split('/').pop()!
    await expect(page.locator(`[data-agent-deployment-target="${id}"]`)).toBeVisible()
    await expect(page.locator('.thinking-status-label')).toHaveText(messages[locale].chat.thinkingInProgress)
    await expect(page.locator('.agent-deployment-overlay')).toHaveCount(0, { timeout: 4000 })
    const frames = await page.evaluate(() => (window as any).deploymentFrames.frames)
    expect(frames.some((f: any) => f.phase === 'landing' && f.targetOpacity === '0')).toBe(true)
    const landing = frames.find((f: any) => f.phase === 'landing' && f.targetOpacity !== '0' && f.opacity === '1')
    expect(landing, JSON.stringify(frames.slice(-12))).toBeDefined()
    expect(Math.abs(landing.dx)).toBeLessThan(1)
    expect(Math.abs(landing.dy)).toBeLessThan(1)
    expect(Math.abs(landing.height - landing.targetHeight)).toBeLessThan(1)
    expect(await page.locator(`[data-agent-deployment-target="${id}"]`).evaluate(el => (el as HTMLElement).style.opacity)).toBe('')
    expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
    expect(errors).toEqual([])
  })
}

test('reduced motion sends the first message without a deployment overlay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openDraft(page, false)
  await page.locator('.new-chat-page textarea').fill('Deploy without motion')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  await expect(page.locator('.agent-deployment-overlay')).toHaveCount(0)
  await expect(page.locator('.thinking-avatar')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
})
