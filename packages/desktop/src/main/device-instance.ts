import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEVICE_INSTANCE_ENV = 'EKKO_STUDIO_DEVICE_INSTANCE'
/** An instance has its own single-instance lock, browser storage and Studio home. */
export function deviceInstanceLaunch(input: {
  home: string; userData: string; serverUrl: string | null; devices: unknown[];
  env: NodeJS.ProcessEnv; argv: string[]; packaged: boolean; id?: string;
}) {
  const id = input.id || randomUUID()
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid device instance ID')
  const home = join(input.home, 'device-instances', id)
  const userData = join(input.userData, 'device-instances', id)
  const env: NodeJS.ProcessEnv = { ...input.env, [DEVICE_INSTANCE_ENV]: id,
    HERMES_WEB_UI_HOME: home, HERMES_WEBUI_STATE_DIR: home, HERMES_HOME: join(home, 'hermes'),
    EKKO_STUDIO_INSTANCE_USER_DATA: userData,
  }
  // Settings, not inherited environment, own the selected device after launch.
  delete env.EKKO_STUDIO_DESKTOP_SERVER_URL
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HERMES_DESKTOP_PORT
  return { id, home, userData, env,
    args: input.packaged ? [] : [input.argv[1]!],
    settings: { serverUrl: input.serverUrl, devices: input.devices },
  }
}

export function prepareDeviceInstance(launch: ReturnType<typeof deviceInstanceLaunch>) {
  mkdirSync(launch.home, { recursive: true })
  mkdirSync(launch.userData, { recursive: true })
  writeFileSync(join(launch.home, 'desktop-remote-server.json'), JSON.stringify(launch.settings), { mode: 0o600 })
}
