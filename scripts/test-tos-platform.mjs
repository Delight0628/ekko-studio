import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api-developer.terra-master.com'
const APP_ID = 'com.hermeswebui.studio'

// Deliberately no confirm/withdraw/delete endpoint: this tool only parses packages.
export async function testTosPlatform({
  directory, env = process.env, request = fetch,
  gh = args => execFileSync('gh', args, { encoding: 'utf8' }).trim(),
  pause = ms => new Promise(done => setTimeout(done, ms)),
}) {
  const token = env.TDP_API_TOKEN
  if (!token) throw new Error('TDP_API_TOKEN secret is required')
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required')
  const repo = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid GITHUB_REPOSITORY')
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Invalid GITHUB_SHA')
  if (!/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('GitHub run identity is required')
  }
  const receipt = { reviewSubmitted: false, sourceSha: env.GITHUB_SHA }
  const saveReceipt = () => writeFile(join(directory, 'platform-test.json'),
    `${JSON.stringify(receipt, null, 2).replaceAll(token, '[REDACTED]').replaceAll(env.GH_TOKEN, '[REDACTED]')}\n`)
  const api = async (path, body) => {
    const response = await request(`${API}/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(`TDP HTTP ${response.status}: ${JSON.stringify(value)}`)
    return value
  }
  try {
    const files = (await readdir(directory)).filter(name => name.endsWith('.deb'))
    if (files.length !== 1) throw new Error('Expected exactly one TOS Deb')
    const filename = files[0]
    const deb = join(directory, filename)
    const report = JSON.parse(await readFile(`${deb}.verification.json`, 'utf8'))
    const checksum = (await readFile(`${deb}.sha256`, 'utf8')).trim().split(/\s+/)
    const bytes = await readFile(deb)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (report.id !== APP_ID || report.platform !== 'x86_64' || report.beta !== true
      || report.filename !== filename || report.sha256 !== hash
      || checksum[0] !== hash || checksum[1] !== filename) {
      throw new Error('TOS package identity/checksum mismatch')
    }
    const identity = await api('/whoami')
    if (!identity.token?.scopes?.includes('version:write')) {
      throw new Error('TDP token needs version:write')
    }
    receipt.developer = { id: identity.developer.id, name: identity.developer.name }
    const repoUrl = `https://github.com/${repo}`
    const apps = await api('/apps?kind=all')
    const matches = apps.filter(app => app.app_id === APP_ID)
    if (matches.length > 1) throw new Error('Ambiguous TOS application registration')
    let app = matches[0]
    if (!app) {
      if (!identity.token.scopes.includes('app:write')) throw new Error('Registration needs app:write')
      app = await api('/apps', { app_id: APP_ID, kind: 'deb', platform: 'x86_64', repo: repoUrl })
    }
    if (!/^[0-9a-f-]{36}$/i.test(app.id)) throw new Error('Invalid application entity UUID')
    app = await api(`/apps/${app.id}`)
    if (app.app_id !== APP_ID || app.kind !== 'deb'
      || app.platform !== 'x86_64' || app.repo?.replace(/\/$/, '') !== repoUrl) {
      throw new Error('Existing application does not match package architecture/repository; not modifying it')
    }
    receipt.appId = app.id
    const versions = await api(`/apps/${app.id}/versions`)
    if (versions.some(version => version.status === 0)) throw new Error('Application already has a version under review')

    const tag = `tos-test-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
    const releaseUrl = gh([
      'release', 'create', tag, deb, `${deb}.sha256`, `${deb}.verification.json`,
      '--repo', repo, '--target', env.GITHUB_SHA, '--prerelease', '--latest=false',
      '--title', `TOS 7 test ${report.version} (${env.GITHUB_RUN_ID})`,
      '--notes', 'Experimental TOS 7 x86_64 package. Device acceptance pending. Not submitted for App Center review.',
    ])
    receipt.releaseUrl = releaseUrl
    receipt.sha256 = hash
    const task = await api(`/apps/${app.id}/versions`, {
      tag,
      browser_download_url: `${repoUrl}/releases/download/${tag}/${filename}`,
    })
    if (!/^[0-9a-f-]{36}$/i.test(task.task_id || '')) throw new Error('Invalid creation task UUID')
    receipt.taskId = task.task_id
    await saveReceipt()
    const taskPath = `/apps/${app.id}/versions/tasks/${task.task_id}`
    for (let attempt = 0; attempt < 180; attempt++) {
      const status = await api(taskPath)
      receipt.taskStatus = status
      if (status.all_status === 3) throw new Error(`TDP package validation failed: ${JSON.stringify(status.steps)}`)
      if (status.all_status === 2) {
        const result = await api(`${taskPath}/result`)
        const { icon, ...metadata } = result
        receipt.parsed = metadata
        if (result.version_number !== report.version || result.platform !== report.platform
          || result.file_hash !== hash || Number(result.file_size) !== bytes.length) {
          throw new Error('Platform parsed metadata differs from the verified package')
        }
        receipt.validationPassed = true
        return receipt
      }
      if (![0, 1].includes(status.all_status)) throw new Error('Unknown platform task status')
      await pause(2000)
    }
    throw new Error('Platform validation timed out; inspect taskId before retrying')
  } catch (error) {
    receipt.error = String(error.message).replaceAll(token, '[REDACTED]').replaceAll(env.GH_TOKEN, '[REDACTED]')
    throw new Error(receipt.error)
  } finally {
    await saveReceipt()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testTosPlatform({ directory: resolve(process.argv[2] || 'release/tos') })
    .then(receipt => console.log(JSON.stringify(receipt, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
