import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}
/** One application installation, not one device/home. No process is force-closed. */
export class InstallationCoordinator {
  private readonly root: string
  private installing = false
  constructor(executable: string, root = join(homedir(), '.ekko-desktop-installations')) {
    const canonical = realpathSync(executable)
    this.root = join(root, createHash('sha256').update(canonical).digest('hex'))
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  private transaction<T>(operation: () => T): T {
    const gate = join(this.root, 'gate')
    const deadline = Date.now() + 1000
    for (;;) {
      try { mkdirSync(gate, { mode: 0o700 }); break } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        if (Date.now() >= deadline) throw new Error('Desktop installation coordination is busy; retry')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try { return operation() } finally { rmdirSync(gate) }
  }
  private members(): number[] {
    return readdirSync(this.root).filter(n => /^\d+\.json$/.test(n)).flatMap(n => {
      const pid = Number(n.slice(0, -5))
      if (alive(pid)) return [pid]
      unlinkSync(join(this.root, n)); return []
    })
  }
  register(installedVersion: string): void {
    this.transaction(() => {
      const pending = join(this.root, 'installing.json')
      try {
        const record = JSON.parse(readFileSync(pending, 'utf8'))
        if (record.version === installedVersion && !alive(record.pid)) unlinkSync(pending)
        else throw new Error('Another Desktop update is in progress; finish the update before opening a device')
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      this.members()
      writeFileSync(join(this.root, `${process.pid}.json`), '{}', { mode: 0o600 })
    })
  }
  beginInstall(targetVersion: string): () => void {
    this.transaction(() => {
      if (this.members().some(pid => pid !== process.pid)) throw new Error('DESKTOP_OTHER_DEVICE_WINDOWS_OPEN')
      writeFileSync(join(this.root, 'installing.json'), JSON.stringify({ pid: process.pid, version: targetVersion }), { flag: 'wx', mode: 0o600 })
      this.installing = true
    })
    return () => this.transaction(() => {
      if (this.installing) { unlinkSync(join(this.root, 'installing.json')); this.installing = false }
    })
  }
  release(): void {
    // Installation marker survives app exit: new starts stay blocked until the
    // new version is running. Failed installs explicitly cancel it.
    try { unlinkSync(join(this.root, `${process.pid}.json`)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}
