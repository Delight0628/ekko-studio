import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTosPlatform } from '../../scripts/test-tos-platform.mjs'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture({ status = 2, mismatch = false, existing = true, appMismatch = false, reviewing = false, httpError = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tos-platform-'))
  directories.push(directory)
  const filename = 'com-hermeswebui-studio_1.2.3_x86_64.deb'
  const bytes = Buffer.from('verified package fixture')
  const hash = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(directory, filename), bytes)
  await writeFile(join(directory, `${filename}.sha256`), `${hash}  ${filename}\n`)
  await writeFile(join(directory, `${filename}.verification.json`), JSON.stringify({
    id: 'com-hermeswebui-studio', version: '1.2.3', platform: 'x86_64', beta: true, filename, sha256: hash,
  }))
  const app = {
    id: '550e8400-e29b-41d4-a716-446655440000', app_id: 'com-hermeswebui-studio',
    kind: 'deb', platform: 'x86_64', repo: `https://github.com/${appMismatch ? 'other/repo' : 'example/studio'}`,
  }
  const env = {
    TDP_API_TOKEN: 'private-tdp-fixture', GH_TOKEN: 'private-github-fixture',
    GITHUB_REPOSITORY: 'example/studio', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  }
  const gh = vi.fn((_args: string[]) => 'https://github.com/example/studio/releases/tag/tos-test-123-1')
  const request = vi.fn(async (url: string, options: any) => {
    expect(options.headers.Authorization).toBe(`Bearer ${env.TDP_API_TOKEN}`)
    expect(options.redirect).toBe('error')
    const path = new URL(url).pathname
    let value: any
    if (path.endsWith('/whoami')) {
      value = { developer: { id: 1, name: 'Example' }, token: { scopes: ['app:write', 'version:write'] } }
    } else if (path === '/v1/apps' && options.method === 'POST') value = app
    else if (path === '/v1/apps') value = existing ? [app] : []
    else if (path.endsWith('/versions') && options.method === 'GET') value = reviewing ? [{ status: 0 }] : []
    else if (path.endsWith('/versions')) value = { task_id: '660e8400-e29b-41d4-a716-446655440000' }
    else if (path.endsWith('/result')) {
      value = { version_number: '1.2.3', platform: 'x86_64', file_hash: mismatch ? 'wrong' : hash, file_size: bytes.length, icon: 'large-image' }
    } else if (path.includes('/tasks/')) value = { all_status: status, steps: { download_step: { status, message: 'fixture failure', advice: 'fixture advice' } } }
    else value = app
    return { ok: !httpError, status: httpError ? 401 : 200, json: async () => httpError ? { detail: env.TDP_API_TOKEN } : value }
  })
  const pause = vi.fn(async () => {})
  return { directory, env, gh, request, pause, filename }
}

describe('TOS platform parsing integration', () => {
  it.each([true, false])('validates exact bytes without confirming review (existing app: %s)', async existing => {
    const f = await fixture({ existing })
    const result = await testTosPlatform(f)
    expect(result.validationPassed).toBe(true)
    expect(result.reviewSubmitted).toBe(false)
    expect(result.parsed).not.toHaveProperty('icon')
    const calls = f.request.mock.calls
    expect(calls.some(([url]) => /confirm|withdraw|cancel/.test(url))).toBe(false)
    const release = f.gh.mock.calls[0][0] as unknown as string[]
    expect(release).toContain('--prerelease')
    expect(release).toContain('--latest=false')
    expect(release).toContain(f.env.GITHUB_SHA)
    expect(JSON.stringify(release)).not.toContain(f.env.TDP_API_TOKEN)
    const receipt = await readFile(join(f.directory, 'platform-test.json'), 'utf8')
    expect(receipt).not.toContain(f.env.TDP_API_TOKEN)
    expect(receipt).not.toContain(f.env.GH_TOKEN)
  })

  it('rejects checksum tampering before any remote side effects', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, f.filename), 'tampered')
    await expect(testTosPlatform(f)).rejects.toThrow('checksum mismatch')
    expect(f.request).not.toHaveBeenCalled()
    expect(f.gh).not.toHaveBeenCalled()
  })

  it.each([
    { appMismatch: true, message: 'Existing application' },
    { reviewing: true, message: 'already has a version under review' },
  ])('refuses conflicting registration/review: $message', async ({ message, ...options }) => {
    const f = await fixture(options)
    await expect(testTosPlatform(f)).rejects.toThrow(message)
    expect(f.gh).not.toHaveBeenCalled()
  })

  it('treats HTTP 200 with failed task state as failure and preserves diagnostics', async () => {
    const f = await fixture({ status: 3 })
    await expect(testTosPlatform(f)).rejects.toThrow('fixture advice')
    expect(f.request.mock.calls.some(([url]) => url.endsWith('/result'))).toBe(false)
    const receipt = JSON.parse(await readFile(join(f.directory, 'platform-test.json'), 'utf8'))
    expect(receipt.taskId).toBeTruthy()
    expect(receipt.taskStatus.all_status).toBe(3)
  })

  it('rejects platform metadata not matching the local bytes', async () => {
    await expect(testTosPlatform(await fixture({ mismatch: true }))).rejects.toThrow('parsed metadata differs')
  })

  it('bounds polling and retains task identity on timeout', async () => {
    const f = await fixture({ status: 1 })
    await expect(testTosPlatform(f)).rejects.toThrow('timed out')
    expect(f.pause).toHaveBeenCalledTimes(180)
    expect(f.request.mock.calls.some(([url]) => url.endsWith('/result'))).toBe(false)
  })

  it('redacts echoed credentials from API errors', async () => {
    const f = await fixture({ httpError: true })
    await expect(testTosPlatform(f)).rejects.toThrow('[REDACTED]')
    expect(await readFile(join(f.directory, 'platform-test.json'), 'utf8')).not.toContain(f.env.TDP_API_TOKEN)
  })
})
