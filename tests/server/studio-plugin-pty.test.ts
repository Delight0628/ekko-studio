import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedProcessScope, parseProcessSpawn } from '../../packages/server/src/modules/studio/services/processes/managed'
import type { ProcessHandle } from '../../packages/studio-plugin-sdk/src'
import { StudioError } from '../../packages/studio-plugin-sdk/src'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.unstubAllEnvs() })
const program = `process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, tty: process.stdin.isTTY, cols: process.stdout.columns, rows: process.stdout.rows, secret: !!process.env.OPENAI_API_KEY }) + '\\n');
process.stdout.on('resize', () => process.stdout.write('SIZE:' + process.stdout.columns + ':' + process.stdout.rows + '\\n'));
process.stderr.write('MERGED-STDERR\\n');
process.stdin.on('data', data => { process.stdout.write('ECHO:' + data.toString('utf8') + '\\n'); });`
async function setup(code = program) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-pty-中文 ')), controller = new AbortController()
  let allowed = true
  const scope = new ManagedProcessScope(controller.signal, () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') })
  close.push(() => rm(directory, { recursive: true, force: true }), () => scope.close())
  const handle = await scope.api.spawn({ command: process.execPath, args: ['-e', code], cwd: directory, terminal: { cols: 90, rows: 30 } })
  return { handle, scope, controller, revoke: () => { allowed = false } }
}
async function until(handle: ProcessHandle, marker: string) {
  const decoder = new TextDecoder(), chunks: string[] = []
  await vi.waitFor(async () => {
    const batch = await handle.read()
    expect(batch.chunks.length).toBeLessThanOrEqual(4)
    expect(batch.chunks.every(chunk => chunk.data.length <= 16_384)).toBe(true)
    expect(batch.chunks.every(chunk => chunk.stream === 'stdout')).toBe(true)
    chunks.push(...batch.chunks.map(chunk => decoder.decode(chunk.data, { stream: true })))
    expect(chunks.join('')).toContain(marker)
  }, { interval: 10, timeout: 2000 })
  return chunks.join('')
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('allocates a real TTY with byte IO, explicit size and merged stderr', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'must-not-be-inherited')
  const f = await setup(), output = await until(f.handle, 'MERGED-STDERR')
  const ready = JSON.parse(output.split(/[\r\n]+/).find(line => line.startsWith('{'))!)
  expect(ready).toMatchObject({ ready: true, tty: true, cols: 90, rows: 30, secret: false })
  await f.handle.write(Buffer.from('中文😀'))
  expect(await until(f.handle, 'ECHO:中文😀')).toContain('ECHO:中文😀')
  await expect(f.handle.end()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await f.scope.close(); expect(alive(ready.pid)).toBe(false)
})

it('resizes the owned terminal and refuses invalid dimensions', async () => {
  const f = await setup()
  await until(f.handle, 'MERGED-STDERR')
  await f.handle.resize!(110, 35)
  expect(await until(f.handle, 'SIZE:110:35')).toContain('SIZE:110:35')
  await expect(f.handle.resize!(0, 35)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it.each(['cancel', 'revoke'])('reaps a terminal and rejects new IO after %s', async action => {
  const f = await setup(), ready = JSON.parse((await until(f.handle, 'MERGED-STDERR')).split(/[\r\n]+/).find(line => line.startsWith('{'))!)
  if (action === 'cancel') f.controller.abort(); else f.revoke()
  await expect(f.handle.write(Buffer.from('not sent'))).rejects.toBeInstanceOf(StudioError)
  await f.scope.close()
  expect(alive(ready.pid)).toBe(false)
})

it('bounds cumulative PTY input when the native API cannot confirm write drainage', async () => {
  const f = await setup(`process.stdin.setRawMode(true); process.stdin.pause(); process.stdout.write('READY\\n');
    let bytes = 0; process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes >= 1048576) process.stdout.write('DRAINED\\n'); });
    process.stdin.pause(); process.stdout.on('resize', () => process.stdin.resume()); setInterval(() => {}, 1000)`)
  await until(f.handle, 'READY')
  for (let n = 0; n < 16; n++) await f.handle.write(Buffer.alloc(65_536, 120))
  await expect(f.handle.write(Buffer.from('overflow'))).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await f.handle.resize!(100, 40)
  await until(f.handle, 'DRAINED')
})

it('validates terminal options without accepting caller-selected ownership or extra fields', () => {
  const base = { command: 'node', args: [], cwd: process.cwd() }
  expect(parseProcessSpawn({ ...base, terminal: { cols: 80, rows: 24 } }).terminal).toEqual({ cols: 80, rows: 24 })
  for (const terminal of [null, {}, { cols: 0, rows: 24 }, { cols: 80, rows: 1001 }, { cols: 80, rows: 24, ownerId: 'forged' }]) {
    expect(() => parseProcessSpawn({ ...base, terminal })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
})

it('pauses terminal output for a slow reader and drains it through bounded byte windows', async () => {
  const f = await setup(`process.stdout.write('BEGIN\\n' + 'x'.repeat(524288) + '\\nEND\\n'); setInterval(() => {}, 1000)`)
  await new Promise(resolve => setTimeout(resolve, 40))
  const output = await until(f.handle, 'END')
  expect(output.split('x').length - 1).toBe(524288)
})

it('terminates descendants in the owned PTY process group', async () => {
  const f = await setup(`const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write('CHILD:' + child.pid + '\\n'); setInterval(() => {}, 1000)`)
  const output = await until(f.handle, 'CHILD:'), childPid = Number(output.match(/CHILD:(\d+)/)![1])
  expect(alive(childPid)).toBe(true)
  await f.scope.close()
  await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 2000 })
})
