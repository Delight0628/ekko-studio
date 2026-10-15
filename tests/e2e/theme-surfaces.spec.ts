import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi } from './fixtures'

for (const customized of [false, true]) {
  test(`keeps shell page headers borderless with ${customized ? 'custom' : 'preset'} wallpaper styling`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      background: { name: 'wallpaper.png', mime: 'image/png', updatedAt: 1 },
      ...(customized ? { appearance: {
        global: { borderWidth: 4, borderColor: '#ff0000', shadow: 2 },
        regions: { chrome: { backgroundColor: '#ccddee', opacity: 0.5, shadow: 2 } },
      } } : {}),
    } })
    await page.goto('/#/hermes/theme')
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
    const header = page.locator('.studio-page-header--shell-sidebar')
    await expect(header).toBeVisible()
    for (const side of ['top', 'right', 'bottom', 'left']) {
      await expect(header).toHaveCSS(`border-${side}-width`, '0px')
    }
    await expect(header).toHaveCSS('box-shadow', 'none')
    await expect(header).toHaveCSS('height', '40px')
    if (customized) {
      await expect(header).toHaveCSS('background-color', 'rgba(204, 221, 238, 0.5)')
      await expect(page.locator('.theme-card').first()).toHaveCSS('border-top-width', '4px')
      await expect(page.locator('.theme-card').first()).not.toHaveCSS('box-shadow', 'none')
      await expect(page.locator('.studio-navigation-rail')).not.toHaveCSS('box-shadow', 'none')
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const contentBlur of [0, 8]) {
  test(`card blur changes the rendered wallpaper with content blur ${contentBlur}px`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      background: { name: 'stripes.png', mime: 'image/png', updatedAt: 1 },
      appearance: { global: { opacity: 0.15 }, regions: { content: { blur: contentBlur }, card: { blur: 0 } } },
    } })
    const wallpaper = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720"><defs><pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><path fill="#222" d="M0 0h24v48H0z"/><path fill="#ddd" d="M24 0h24v48H24z"/></pattern></defs><path fill="url(#p)" d="M0 0h960v720H0z"/></svg>')).png().toBuffer()
    await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: wallpaper }))
    await page.goto('/#/hermes/theme')
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
    await page.getByTestId('theme-scope').selectOption('card')
    const card = page.locator('.theme-card').first()
    await card.scrollIntoViewIfNeeded()
    const rect = (await card.boundingBox())!
    const clip = { x: rect.x + rect.width / 2, y: rect.y + 5, width: 200, height: 8 }
    const before = await sharp(await page.screenshot({ clip })).stats()
    expect(before.channels[0].stdev).toBeGreaterThan(10)
    await page.getByTestId('theme-card-blur').evaluate(element => {
      const input = element as HTMLInputElement
      input.value = '30'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(card).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    const after = await sharp(await page.screenshot({ clip })).stats()
    expect(after.channels[0].stdev).toBeLessThan(before.channels[0].stdev * 0.5)
    await expect(page.locator('.theme-library')).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    await expect(page.locator('.theme-appearance-editor')).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    expect(api.requests.filter(request => request.method === 'PUT' && request.pathname === '/api/theme')).toHaveLength(0)
    await page.getByTestId('theme-card-blur').dispatchEvent('change')
    await page.reload()
    await expect(card).toHaveCSS('backdrop-filter', 'blur(30px) saturate(1.1)')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background blur', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/theme-card-filter/)
    await expect(page.locator('.app-main--card')).toHaveCSS('backdrop-filter', `blur(${contentBlur}px) saturate(1.1)`)
    await expect(page.locator('.app-main--card')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.15)')
    expect(api.unexpectedRequests).toEqual([])
  })
}

for (const brightness of ['light', 'dark']) {
  test(`version preview follows regional card colors and transparency in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness,
      appearance: { global: {}, regions: { card: { backgroundColor: '#336699', opacity: 0.25, blur: 12, radius: 16, borderColor: '#6688aa', shadow: 0 } } },
    } })
    await page.route('**/api/studio/update/preview', route => route.fulfill({ json: {
      preview_dir: '/tmp/studio-preview', webui_home: '/tmp/studio-preview-home',
      current_tag: 'v0.7.35', has_package: true, installed: true, running: false,
      frontend_url: 'http://localhost:8650', action_log_path: '/tmp/action.log', dev_log_path: '/tmp/dev.log',
      action_log: 'Dependencies installed.', dev_log: 'Preview ready.', active_action: null,
    } }))
    await page.route('**/api/studio/update/preview/tags', route => route.fulfill({ json: { tags: [{ name: 'v0.7.35', sha: 'abc123' }] } }))
    await page.goto('/#/hermes/version-preview')
    const table = page.locator('.status-table .n-descriptions-table-wrapper')
    await expect(table).toBeVisible()
    for (const surface of [table, page.locator('.log-output')]) {
      await expect(surface).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect(surface).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(surface).toHaveCSS('border-radius', '16px')
      await expect(surface).toHaveCSS('border-top-color', 'rgb(102, 136, 170)')
    }
    const tint = brightness === 'dark' ? 'rgba(224, 224, 224, 0.04)' : 'rgba(26, 26, 26, 0.04)'
    await expect(table.locator('th').first()).toHaveCSS('background-color', tint)
    await expect(table.locator('td').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('.log-title').first()).toHaveCSS('background-color', tint)
    await expect(page.locator('.log-box pre').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({ path: `/tmp/studio-version-preview-theme-${brightness}.png`, fullPage: true })
    await page.locator('.log-output').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/studio-version-preview-logs-${brightness}.png` })
    expect(api.unexpectedRequests).toEqual([])
  })
}
