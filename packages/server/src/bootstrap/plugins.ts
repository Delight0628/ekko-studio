import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { configureStudioPluginRuntime, createStudioPluginRuntime } from '../modules/studio/services/plugins/runtime'

export async function startStudioPlugins() {
  const bundled = resolve(__dirname, 'plugin-runner.cjs')
  const runnerPath = existsSync(bundled) ? bundled : resolve(__dirname, '../../../../dist/server/plugin-runner.cjs')
  const runtime = createStudioPluginRuntime(runnerPath)
  configureStudioPluginRuntime(runtime)
  await runtime.host.restore()
  return runtime
}
