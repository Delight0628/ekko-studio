import { Readable } from 'node:stream'
import type { Context } from 'koa'
import { getActiveProfileName, listProfileNamesFromDisk } from '../public/profile-config'
import { listApiModels, prepareModelResponse } from '../services/model-api/service'
import { ModelApiError, modelApiErrorBody } from '../services/model-api/errors'

function profileForRequest(ctx: Context): string {
  const user = ctx.state.user
  let profile = ctx.state.profile?.name
  if (!profile && user?.role !== 'super_admin') {
    if (user?.profiles?.length !== 1) throw new ModelApiError('Select a Profile using the x-hermes-profile header.', 400, 'profile')
    profile = user.profiles[0]
  }
  profile ||= getActiveProfileName() || 'default'
  if (user?.role !== 'super_admin' && !user?.profiles?.includes(profile)) throw new ModelApiError('Profile is not available for this user.', 403, 'profile')
  if (!listProfileNamesFromDisk().includes(profile)) throw new ModelApiError('Profile does not exist.', 404, 'profile')
  return profile
}

export async function modelApiModels(ctx: Context) {
  try { ctx.body = await listApiModels(profileForRequest(ctx)) }
  catch (error) { const result = modelApiErrorBody(error); ctx.status = result.status; ctx.body = result.body }
}

export async function modelApiResponses(ctx: Context) {
  const abort = new AbortController()
  const onClose = () => { if (!ctx.res.writableEnded) abort.abort() }
  ctx.res.once('close', onClose)
  let streaming = false
  try {
    const request = await prepareModelResponse({
      profile: profileForRequest(ctx), accountId: ctx.state.user ? String(ctx.state.user.id) : undefined,
      body: ctx.request.body, signal: abort.signal,
    })
    ctx.set('x-request-id', request.id)
    if (!request.stream) { ctx.body = await request.create(); return }
    ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Accel-Buffering', 'no')
    streaming = true
    ctx.body = Readable.from((async function* () {
      try {
        for await (const event of request.events()) yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      } finally {
        abort.abort()
        ctx.res.off('close', onClose)
      }
    })())
  } catch (error) {
    const result = modelApiErrorBody(error)
    ctx.status = result.status; ctx.body = result.body
  } finally {
    if (!streaming) ctx.res.off('close', onClose)
  }
}
