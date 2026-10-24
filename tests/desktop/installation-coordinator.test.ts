import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { InstallationCoordinator } from '../../packages/desktop/src/main/installation-coordinator'

it('blocks update before shutdown with another process and blocks starts during install', async () => {
 const root=mkdtempSync(join(tmpdir(),'install-coord-'))
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
 try {
  const coordinator=new InstallationCoordinator(process.execPath,root)
  coordinator.register('1.0.0')
  const registry=join(root,readdirSync(root)[0])
  writeFileSync(join(registry,`${child.pid}.json`),'{}')
  expect(()=>coordinator.beginInstall('2.0.0')).toThrow('DESKTOP_OTHER_DEVICE_WINDOWS_OPEN')
  child.kill();await once(child,'close')
  const cancel=coordinator.beginInstall('2.0.0')
  expect(()=>new InstallationCoordinator(process.execPath,root).register('1.0.0')).toThrow('update is in progress')
  cancel()
  expect(()=>new InstallationCoordinator(process.execPath,root).register('1.0.0')).not.toThrow()
  coordinator.release()
 }finally {child.kill();rmSync(root,{recursive:true,force:true})}
})
it('does not accept a new version marker until installer process has exited',()=>{
 const root=mkdtempSync(join(tmpdir(),'install-version-'))
 try {
  const c=new InstallationCoordinator(process.execPath,root);c.register('1.0.0')
  const cancel=c.beginInstall('2.0.0')
  expect(()=>c.register('2.0.0')).toThrow('update is in progress')
  cancel();c.release()
 }finally {rmSync(root,{recursive:true,force:true})}
})
it('accepts a completed new-version handoff but refuses a dead old-version start',()=>{
 const root=mkdtempSync(join(tmpdir(),'install-handoff-'))
 try {
  const c=new InstallationCoordinator(process.execPath,root)
  const registry=join(root,readdirSync(root)[0])
  // A large PID absent in the test host models the completed installer owner.
  const dead=2147483647
  writeFileSync(join(registry,'installing.json'),JSON.stringify({pid:dead,version:'2.0.0'}))
  expect(()=>c.register('1.0.0')).toThrow('update is in progress')
  expect(()=>c.register('2.0.0')).not.toThrow()
  c.release()
 }finally {rmSync(root,{recursive:true,force:true})}
})
