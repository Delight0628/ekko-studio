import { writeFileSync } from 'node:fs'
const token = process.env.TDP_API_TOKEN
const appId = '403b52e8-d760-4737-901a-b15b67088880'
const receipt = { mode: process.env.TOS_MODE, reviewSubmitted: false }
const api = async path => {
  const response = await fetch(`https://api-developer.terra-master.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`TDP HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}
try {
  if (!token) throw new Error('TDP_API_TOKEN required')
  if (process.env.TOS_MODE !== 'inspect') throw new Error('Only read-only inspection is enabled at this commit')
  const identity = await api('/whoami')
  if (identity.developer?.id !== 56) throw new Error('Unexpected developer identity')
  receipt.scopes = identity.token?.scopes
  const app = await api(`/apps/${appId}`)
  if (app.app_id !== 'com.hermeswebui.studio' || app.platform !== 'x86_64') throw new Error('Unexpected app')
  receipt.app = { id: app.id, app_id: app.app_id, repo: app.repo, kind: app.kind, platform: app.platform }
  receipt.versions = await api(`/apps/${appId}/versions`)
  receipt.current = []
  for (const v of receipt.versions.filter(v => v.status === 0 || v.version === '0.7.36')) {
    receipt.current.push({ detail: await api(`/apps/${appId}/versions/${v.id}`), reviews: await api(`/apps/${appId}/versions/${v.id}/reviews`) })
  }
} catch (error) { receipt.error = error.message; process.exitCode = 1 }
finally {
  const safe = JSON.stringify(receipt, (key, value) => key === 'icon' ? '[omitted]' : value, 2).replaceAll(token || 'NO_TOKEN_VALUE', '[REDACTED]')
  writeFileSync('tos-resubmit-receipt.json', safe + '\n')
  console.log(JSON.stringify({ mode: receipt.mode, versions: receipt.versions, error: receipt.error }))
}
