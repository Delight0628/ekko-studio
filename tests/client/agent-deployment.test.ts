// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentDeployment } from '@/components/hermes/chat/agentDeployment.mjs'

describe('Agent deployment lifecycle', () => {
  let surface: HTMLElement
  let source: HTMLElement
  let avatar: HTMLElement
  let frame: FrameRequestCallback
  const bounds = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })
  const tick = (elapsed: number) => frame(100 + elapsed)
  const overlay = () => document.querySelector<HTMLElement>('.agent-deployment-overlay')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    document.body.innerHTML = `<div data-agent-deployment-surface data-agent-deployment-session="new" data-agent-deployment-active="true">
      <button class="agent-card active"><span class="agent-card-name">Ekko</span></button>
      <img data-agent-deployment-target="new" style="opacity:.85" />
    </div>`
    surface = document.body.firstElementChild as HTMLElement
    source = surface.querySelector('button')!
    avatar = surface.querySelector('img')!
    surface.getBoundingClientRect = () => bounds(0, 0, 390, 844)
    source.getBoundingClientRect = () => bounds(110, 240, 170, 260)
    avatar.getBoundingClientRect = () => bounds(28, 108, 32, 32)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('survives source unmount, lands on the actual avatar, then restores its style', () => {
    prepareAgentDeployment(source)!.start('new')
    source.remove()
    tick(50)
    expect(overlay()?.dataset.phase).toBe('summoning')
    tick(1400)
    expect(avatar.style.opacity).toBe('0')
    tick(1800)
    expect(avatar.style.opacity).toBe('0.85')
    expect(overlay()?.querySelector<HTMLElement>('.agent-deployment-hero')?.style.transform)
      .toContain('translate3d(-41px,-6px,0) scale(0.12307692307692308)')
    tick(1990)
    expect(overlay()).toBeNull()
  })

  it.each(['session', 'mode', 'avatar'])('cleans up during flight when the %s changes', change => {
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    tick(1400)
    if (change === 'session') surface.dataset.agentDeploymentSession = 'other'
    if (change === 'mode') surface.dataset.agentDeploymentActive = 'false'
    if (change === 'avatar') avatar.remove()
    tick(1500)
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('fades out a fast reply without landing on another session’s avatar', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    avatar.dataset.agentDeploymentTarget = 'old'
    tick(1400)
    expect(overlay()?.dataset.phase).toBe('finishing')
    expect(avatar.style.opacity).toBe('0.85')
    tick(1580)
    expect(overlay()).toBeNull()
  })

  it('has a bounded fallback when the request fails or no thinking avatar appears', () => {
    avatar.remove()
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    tick(2100)
    tick(2280)
    expect(overlay()).toBeNull()
  })

  it('cancels a hidden page and restores the masked avatar', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('skips reduced motion and capture failures without blocking submission', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(prepareAgentDeployment(source)).toBeNull()
    vi.stubGlobal('matchMedia', vi.fn(() => { throw new Error('Unavailable view layer') }))
    expect(prepareAgentDeployment(source)).toBeNull()
  })

  it('replaces a previous deployment and has a cleanup deadline even without frames', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    prepareAgentDeployment(source)!.start('new')
    expect(document.querySelectorAll('.agent-deployment-overlay')).toHaveLength(1)
    expect(avatar.style.opacity).toBe('0.85')
    vi.advanceTimersByTime(2600)
    expect(overlay()).toBeNull()
  })
})
