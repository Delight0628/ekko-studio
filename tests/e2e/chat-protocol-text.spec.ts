import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test('chat hides leaked XML protocol, preserves examples and does not link bare filenames', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Inspect a document')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.some((entry: any) => entry.event === 'run'))
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const sid = state.emitted.find((entry: any) => entry.event === 'run').payload.session_id
    const text = '<tool_call><invoke name="read_file"><parameter name="path">hidden-protocol-payload</parameter></invoke></tool_call>\n'
      + 'Visible answer: DESIGN.md backup.sh main.py\n\n'
      + '```xml\n<tool_call>documented-example</tool_call>\n```\n\nhttps://example.com'
    state.latest.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'protocol-test' })
    state.latest.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'protocol-test', delta: text })
    state.latest.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'protocol-test', output: text })
  })
  const answer = page.locator('.markdown-body').filter({ hasText: 'Visible answer:' })
  await expect(answer).toBeVisible()
  await expect(answer).not.toContainText('hidden-protocol-payload')
  await expect(answer.locator('pre')).toContainText('documented-example')
  await expect(answer.locator('a[href^="http://DESIGN.md"], a[href^="http://backup.sh"], a[href^="http://main.py"]')).toHaveCount(0)
  await expect(answer.locator('a[href="https://example.com"]')).toBeVisible()
})
