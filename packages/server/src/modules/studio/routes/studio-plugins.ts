import Router from '@koa/router'
import * as controller from '../controllers/studio-plugins'
import { requireSuperAdmin, requireUserProfile } from '../public/auth'

export const studioPluginRoutes = new Router()
studioPluginRoutes.get('/api/studio/plugins', requireSuperAdmin, controller.listPlugins)
studioPluginRoutes.post('/api/studio/plugins', requireSuperAdmin, controller.installPlugin)
studioPluginRoutes.get('/api/studio/plugins/:id/profile', requireSuperAdmin, requireUserProfile, controller.getPluginProfile)
studioPluginRoutes.put('/api/studio/plugins/:id/profile', requireSuperAdmin, requireUserProfile, controller.configurePlugin)
studioPluginRoutes.delete('/api/studio/plugins/:id', requireSuperAdmin, controller.removePlugin)
studioPluginRoutes.get('/api/studio/agent-types', requireUserProfile, controller.listAgentTypes)
studioPluginRoutes.get('/api/studio/agent-instances', requireUserProfile, controller.listAgentInstances)
studioPluginRoutes.post('/api/studio/agent-instances', requireUserProfile, controller.createAgentInstance)
studioPluginRoutes.post('/api/studio/agent-instances/:id/runs', requireUserProfile, controller.startAgentExecution)
studioPluginRoutes.get('/api/studio/agent-runs/:id', requireUserProfile, controller.getAgentExecution)
studioPluginRoutes.get('/api/studio/agent-runs/:id/output', requireUserProfile, controller.getAgentExecutionOutput)
studioPluginRoutes.post('/api/studio/agent-runs/:id/cancel', requireUserProfile, controller.cancelAgentExecution)
studioPluginRoutes.get('/api/studio/agent-runs/:id/interactions', requireUserProfile, controller.getAgentExecutionInteractions)
studioPluginRoutes.get('/api/studio/agent-runs/:id/usage', requireUserProfile, controller.getAgentExecutionUsage)
studioPluginRoutes.post('/api/studio/agent-runs/:id/respond', requireUserProfile, controller.respondAgentExecution)
