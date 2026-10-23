import type { WebContentsView } from 'electron'

export type BrowserColorScheme = 'light' | 'dark'
export function browserBackground(scheme: BrowserColorScheme): string {
  return scheme === 'dark' ? '#1a1a1a' : '#ffffff'
}
/** Respect website CSS and preferences; never inject forced inversion or page scripts. */
export async function applyBrowserColorScheme(view: WebContentsView, scheme: BrowserColorScheme): Promise<void> {
  view.setBackgroundColor(browserBackground(scheme))
  const contents = view.webContents
  if (contents.isDestroyed()) return
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  })
}
