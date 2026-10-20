import type { Context } from 'koa'
import { desktopBrowserRelays } from '../services/browser/desktop-relay'

export async function requestDesktopBrowser(ctx: Context): Promise<void> {
  const user = ctx.state.user
  // Server-token and anonymous requests cannot inherit another user's desktop.
  if (!user) { ctx.status = 403; ctx.body = { error: 'Desktop browser requires an identified Studio user' }; return }
  try {
    if (!ctx.request.body || typeof ctx.request.body !== 'object' || Array.isArray(ctx.request.body)) throw new Error('Browser request body must be an object')
    ctx.body = await desktopBrowserRelays.request(user.id, ctx.state.profile?.name || 'default', ctx.request.body as Record<string, unknown>)
  } catch (error) {
    ctx.status = 409
    ctx.body = { error: error instanceof Error ? error.message : 'Desktop browser request failed' }
  }
}
