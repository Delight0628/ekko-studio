import Router from '@koa/router'
import * as ctrl from '../controllers/model-api'

export const modelApiRoutes = new Router()
modelApiRoutes.get('/api/studio/models/v1/models', ctrl.modelApiModels)
modelApiRoutes.post('/api/studio/models/v1/responses', ctrl.modelApiResponses)
