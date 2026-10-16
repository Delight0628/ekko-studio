import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const launches = vi.hoisted(() => [] as any[])
vi.mock('@modelcontextprotocol/client/stdio', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>()
  return { ...actual, StdioClientTransport: class extends actual.StdioClientTransport {
    constructor(options: any) {
      launches.push(options)
      super({ ...options, command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/fake-cua-driver.cjs')] })
    }
  } }
})

import { ComputerUseTool } from '../../packages/ekko-agent/src/tools/computer-use'
import { computerUseEnvironment } from '../../packages/ekko-agent/src/tools/computer-use/driver'
import { createDefaultToolRegistry, EkkoToolApprovalService, setupEkkoAgent, type AgentToolContext } from '../../packages/ekko-agent/src'

let directory: string
const scopes: AbortController[] = []
const tools: ComputerUseTool[] = []
function fixture() {
  const scope = new AbortController()
  scopes.push(scope)
  const context: AgentToolContext = { computerUseSessionSignal: scope.signal, workspaceRoot: directory, runId: `run-${scopes.length}`, sessionId: `session-${scopes.length}` }
  const tool = new ComputerUseTool({ driverPath: process.execPath, timeoutMs: 3000 })
  tools.push(tool)
  const describeTool = (name: string) => tool.execute({ action: 'describe', tool: name }, context)
  const call = (name: string, args = {}) => tool.execute({ action: 'call', tool: name, arguments: args }, context)
  return { tool, context, scope, describeTool, call }
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ekko-cua-test-')); launches.length = 0 })
afterEach(async () => {
  await Promise.all(tools.splice(0).map((tool, i) => tool.execute({ action: 'close' }, { computerUseSessionSignal: scopes[i].signal })))
  for (const scope of scopes.splice(0)) scope.abort()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('Ekko Computer Use', () => {
  it('discovers paginated operations lazily and keeps one direct driver per run', async () => {
    const { tool, context, describeTool, call } = fixture()
    expect(launches).toHaveLength(0)
    const list = await tool.execute({ action: 'list' }, context)
    expect(list.ok).toBe(true)
    expect(list.content).toContain('type_text')
    expect(list.content).not.toContain('set_config')
    expect(list.content).not.toContain('kill_app')
    await describeTool('list_apps')
    const first = await call('list_apps')
    const second = await call('list_apps')
    expect((first.data as any).result.pid).toBe((second.data as any).result.pid)
    expect(launches).toHaveLength(1)
    expect(launches[0].args).toEqual(['mcp', '--direct', '--no-overlay'])
  })

  it('keeps snapshot ownership stable without a run ID and renews it after explicit close', async () => {
    const { tool, context, describeTool, call } = fixture()
    delete context.runId
    await describeTool('get_window_state')
    const first = (await call('get_window_state', { pid: 1, window_id: 2 })).data as any
    await describeTool('click')
    const click = await call('click', { pid: 1, window_id: 2, element_token: first.result.elements[0].element_token })
    expect(click.ok).toBe(true)
    expect((click.data as any).result.args.session).toBe(first.result.args.session)
    await tool.execute({ action: 'close' }, context)
    await describeTool('get_window_state')
    const next = (await call('get_window_state', { pid: 1, window_id: 2 })).data as any
    expect(next.result.args.session).not.toBe(first.result.args.session)
    expect(launches).toHaveLength(2)
  })

  it('returns a real image part, a shareable local file and snapshot-bound handles without logging image data', async () => {
    const { describeTool, call } = fixture()
    await describeTool('get_window_state')
    const capture = await call('get_window_state', { pid: 1, window_id: 2 })
    expect(capture.ok).toBe(true)
    expect(capture.contentParts?.some(part => part.type === 'image')).toBe(true)
    const { screenshots, result } = capture.data as any
    expect(await readFile(screenshots[0])).toEqual(Buffer.from((capture.contentParts!.find(part => part.type === 'image') as any).data, 'base64'))
    expect(result.args).toMatchObject({ max_elements: 300, session: expect.stringMatching(/^ekko-/) })
    expect(JSON.stringify(capture.data)).not.toContain('iVBOR')
    await describeTool('click')
    expect((await call('click', { pid: 1, window_id: 2, element_token: result.elements[0].element_token })).ok).toBe(true)
    await call('get_window_state', { pid: 1, window_id: 2 })
    expect(await call('click', { pid: 1, window_id: 2, element_token: result.elements[0].element_token })).toMatchObject({ ok: false, error: expect.stringContaining('stale') })
  })

  it('requires discovery, denies session takeover and keeps permission checks read-only', async () => {
    const { describeTool, call } = fixture()
    expect((await call('click')).error).toContain('Describe click')
    expect((await describeTool('set_config')).error).toContain('Unsupported')
    await describeTool('get_window_state')
    expect((await call('get_window_state', { session: 'another-user' })).ok).toBe(false)
    expect((await call('get_window_state', { screenshot_out_file: '/arbitrary/file' })).ok).toBe(false)
    await describeTool('check_permissions')
    const check = await call('check_permissions', { prompt: true, probe_direct_capture: true })
    expect((check.data as any).result.args).toMatchObject({ prompt: false, probe_direct_capture: false })
  })

  it('uses the accessibility tree for text-only models', async () => {
    const { context, describeTool, call } = fixture()
    context.modelCapabilities = { vision: false } as any
    await describeTool('get_window_state')
    const capture = await call('get_window_state', { pid: 1, window_id: 2 })
    expect((capture.data as any).result.args.include_screenshot).toBe(false)
    expect(capture.contentParts).toBeUndefined()
    await describeTool('get_desktop_state')
    expect((await call('get_desktop_state')).error).toContain('VISION_UNSUPPORTED')
  })

  it('prevents competing desktop controllers and frees the lease when a run closes', async () => {
    const first = fixture(), second = fixture()
    await first.describeTool('list_windows')
    await second.describeTool('list_windows')
    expect((await first.call('list_windows')).ok).toBe(true)
    expect((await second.call('list_windows')).error).toContain('COMPUTER_USE_BUSY')
    await first.tool.execute({ action: 'close' }, first.context)
    expect((await second.call('list_windows')).ok).toBe(true)
  })

  it('closes the subprocess on cancellation and refuses reusing its scope', async () => {
    const { describeTool, call, scope } = fixture()
    await describeTool('list_apps')
    const pid = (await call('list_apps')).data as any
    scope.abort()
    await vi.waitFor(() => expect(() => process.kill(pid.result.pid, 0)).toThrow())
    expect((await call('list_apps')).ok).toBe(false)
  })

  it('never retries an input that times out', async () => {
    const { context, scope } = fixture()
    const tool = new ComputerUseTool({ driverPath: process.execPath, timeoutMs: 1000 })
    expect((await tool.execute({ action: 'describe', tool: 'type_text' }, context)).ok).toBe(true)
    const failed = await tool.execute({ action: 'call', tool: 'type_text', arguments: { text: '__hang__', pid: 1, window_id: 2 } }, context)
    expect(failed.error).toContain('outcome is unknown')
    const repeat = await tool.execute({ action: 'call', tool: 'type_text', arguments: { text: '__hang__', pid: 1, window_id: 2 } }, context)
    expect(repeat.error).toContain('connection has ended')
    expect(launches).toHaveLength(1)
    scope.abort()
  })

  it('requires a run scope, blocks delegated control and reports missing drivers without launching', async () => {
    const { tool, context } = fixture()
    expect((await tool.execute({ action: 'list' })).error).toContain('run-scoped')
    expect((await tool.execute({ action: 'list' }, { ...context, delegationDepth: 1 })).error).toContain('main agent')
    const absent = new ComputerUseTool({ driverPath: join(directory, 'absent') })
    expect((await absent.execute({ action: 'status' })).ok).toBe(false)
    expect(launches).toHaveLength(0)
  })

  it('strips credentials and permission bypasses from the driver environment', () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-for-cua')
    vi.stubEnv('CUA_DRIVER_PERMISSION_MODE', 'unrestricted')
    vi.stubEnv('CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED', '1')
    vi.stubEnv('CUA_DRIVER_RS_SOCKET', '/other/daemon')
    expect(computerUseEnvironment()).toMatchObject({ CUA_DRIVER_PERMISSION_MODE: 'standard', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', ELECTRON_RUN_AS_NODE: '1' })
    expect(computerUseEnvironment()).not.toHaveProperty('OPENAI_API_KEY')
    expect(computerUseEnvironment()).not.toHaveProperty('CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED')
    expect(computerUseEnvironment()).not.toHaveProperty('CUA_DRIVER_RS_SOCKET')
  })

  it('uses existing approvals and keeps foreground grants separate', async () => {
    const service = new EkkoToolApprovalService({ configPath: join(directory, 'config.json') })
    const registry = createDefaultToolRegistry({ authorizer: service.authorize })
    const call = { action: 'call', tool: 'click', arguments: { pid: 1, window_id: 2, element_token: 's00000001:1' } }
    expect(await registry.execute('computer_use', call, { sessionId: 'test' })).toMatchObject({ ok: false, error: expect.stringContaining('requires approval') })
    expect(launches).toHaveLength(0)
    const requestToolApproval = vi.fn(async () => 'session' as const)
    const context = { sessionId: 'test', requestToolApproval }
    await service.authorize('computer_use', call, context)
    await service.authorize('computer_use', call, context)
    await service.authorize('computer_use', { ...call, arguments: { ...call.arguments, delivery_mode: 'foreground' } }, context)
    expect(requestToolApproval).toHaveBeenCalledTimes(2)
    expect(requestToolApproval.mock.calls[0][0].key).toBe('computer_use:click:background')
    expect(requestToolApproval.mock.calls[1][0].key).toBe('computer_use:click:foreground')
  })

  it('persists config, merges partial updates, and removes the tool when disabled', () => {
    const setup = setupEkkoAgent({ baseDirectory: directory })
    try {
      expect(setup.config.read().tools.computerUse).toEqual({ enabled: true, driverPath: '', timeoutMs: 30_000 })
      setup.config.update({ tools: { computerUse: { driverPath: process.execPath } } })
      setup.config.update({ tools: { computerUse: { enabled: false } } })
      expect(setup.config.read().tools.computerUse).toEqual({ enabled: false, driverPath: process.execPath, timeoutMs: 30_000 })
      expect(createDefaultToolRegistry({ computerUse: { enabled: false } }).get('computer_use')).toBeUndefined()
      expect(() => setup.config.update({ tools: { computerUse: { driverPath: 'relative/path' } } })).toThrow('absolute')
    } finally { setup.close() }
  })
})
