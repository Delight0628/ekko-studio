import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Ajv, AjvJsonSchemaValidator, addFormats } from '@modelcontextprotocol/client/validators/ajv'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { COMPUTER_USE_INPUT_TOOLS, COMPUTER_USE_READ_TOOLS } from './policy'

export function resolveComputerUseDriver(configuredPath = ''): string {
  const override = configuredPath.trim() || process.env.EKKO_CUA_DRIVER_PATH?.trim()
  if (override) {
    if (!isAbsolute(override) || !executable(override)) throw new Error('Computer Use driverPath must name an existing executable using an absolute path.')
    return override
  }
  const binary = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const candidates = [
    ...String(process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean).filter(isAbsolute).map(dir => join(dir, binary)),
    join(homedir(), '.local', 'bin', binary),
    ...(process.platform === 'darwin' ? [
      '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      join(homedir(), 'Applications/CuaDriver.app/Contents/MacOS/cua-driver'),
    ] : []),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [
      join(process.env.LOCALAPPDATA, 'Programs', 'Cua', 'cua-driver', 'bin', binary),
    ] : []),
  ]
  const found = candidates.find(executable)
  if (!found) throw new Error('CUA_DRIVER_NOT_FOUND: Install Cua Driver from https://cua.ai/docs/cua-driver and set its executable path in Ekko Settings → Tools → Computer Use. Hermes is not required.')
  return found
}

function executable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(file).isFile()
  } catch { return false }
}

export function computerUseEnvironment(): Record<string, string> {
  // Do not inherit model credentials, proxy credentials, daemon sockets or Cua
  // permission bypasses. Each run owns a direct standard-mode native runtime.
  const allowed = new Set([
    'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'COMSPEC', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
  ])
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => allowed.has(entry[0]) && typeof entry[1] === 'string')),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    ELECTRON_RUN_AS_NODE: '1',
  }
}

export class ComputerUseDriverSession {
  readonly id = `ekko-${randomUUID()}`
  readonly described = new Set<string>()
  private readonly client = new Client({ name: 'ekko-computer-use', version: '1.0.0' }, { jsonSchemaValidator: driverValidator() })
  private transport?: StdioClientTransport
  private ready?: Promise<void>
  private tools: any[] = []
  private stderr = ''
  private closed = false
  private pendingCall: Promise<unknown> = Promise.resolve()

  constructor(readonly command: string, private readonly timeoutMs: number) {}

  async list(signal?: AbortSignal): Promise<any[]> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Computer Use connection has ended; start a new run and capture fresh state.')
    this.ready ??= this.connect(signal)
    await this.ready
    signal?.throwIfAborted()
    return this.tools
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const operation = this.pendingCall.then(() => this.dispatch(name, args, signal))
    this.pendingCall = operation.catch(() => undefined)
    return operation
  }

  private async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.list(signal)
    try {
      return await this.client.callTool({ name, arguments: args }, { timeout: this.timeoutMs, signal })
    } catch (error) {
      // A timed-out input may already have taken effect. Never replay it.
      await this.close()
      throw new Error(`${this.diagnostic(error)} The action outcome is unknown; inspect fresh state before retrying.`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.client.close().catch(() => undefined)
    await this.transport?.close().catch(() => undefined)
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.command,
      args: ['mcp', '--direct', '--no-overlay'],
      env: computerUseEnvironment(),
      stderr: 'pipe',
    })
    this.transport.stderr?.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000) })
    try {
      await this.client.connect(this.transport, { timeout: this.timeoutMs, signal })
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeoutMs, signal })
        this.tools.push(...page.tools.filter(tool => COMPUTER_USE_READ_TOOLS.has(tool.name) || COMPUTER_USE_INPUT_TOOLS.has(tool.name)))
        cursor = page.nextCursor
        if (cursor && seen.has(cursor)) throw new Error('Cua Driver returned a repeated tools cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      if (!this.tools.some(tool => tool.name === 'get_window_state')) throw new Error('Cua Driver does not advertise get_window_state')
    } catch (error) {
      await this.close()
      throw new Error(this.diagnostic(error))
    }
  }

  private diagnostic(error: unknown): string {
    return `CUA_DRIVER_CONNECTION_FAILED (${this.command}): ${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr}` : ''}\nEkko requires Cua Driver with mcp --direct support (validated with 0.26.1). Check the configured executable and host Accessibility / Screen Recording permissions. Do not reconnect input automatically.`
  }
}

function driverValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({ strict: false, validateSchema: false, allErrors: true })
  addFormats(ajv)
  // Cua uses Rust integer format annotations on otherwise ordinary JSON numbers.
  ajv.addFormat('uint32', { type: 'number', validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff })
  ajv.addFormat('uint64', { type: 'number', validate: (value: number) => Number.isSafeInteger(value) && value >= 0 })
  return new AjvJsonSchemaValidator(ajv)
}
