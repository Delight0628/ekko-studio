import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function pythonBuildEnvironment(env = process.env, platform = process.platform, arch = process.arch, exists = existsSync) {
  const result = { ...env }
  if (platform === 'win32' && arch === 'arm64') {
    // winpty-rs detects winpty-agent on PATH and links its adjacent library.
    // Git for Windows on the ARM runner also includes an x64 MSYS winpty;
    // hide that optional legacy backend so pywinpty builds native ConPTY.
    for (const key of Object.keys(result).filter(key => key.toLowerCase() === 'path')) {
      result[key] = result[key].split(';').filter(directory =>
        !exists(join(directory, 'winpty-agent.exe')),
      ).join(';')
    }
  }
  if (platform === 'darwin') {
    if (!result.AR && exists('/usr/bin/ar')) result.AR = '/usr/bin/ar'
    if (!result.RANLIB && exists('/usr/bin/ranlib')) result.RANLIB = '/usr/bin/ranlib'
  }
  return result
}
