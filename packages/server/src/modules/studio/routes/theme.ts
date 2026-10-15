import Router from '@koa/router'
import * as ctrl from '../controllers/theme'

export const themeRoutes = new Router()

themeRoutes.get('/api/theme', ctrl.getTheme)
themeRoutes.put('/api/theme', ctrl.updateTheme)
themeRoutes.post('/api/theme/background', ctrl.uploadThemeBackground)
themeRoutes.get('/api/theme/background', ctrl.getThemeBackground)
themeRoutes.delete('/api/theme/background', ctrl.deleteThemeBackground)

themeRoutes.get('/api/theme/presets', ctrl.listPresets)
themeRoutes.post('/api/theme/presets', ctrl.createPreset)
themeRoutes.patch('/api/theme/presets/:id', ctrl.renamePreset)
themeRoutes.post('/api/theme/presets/:id/activate', ctrl.activatePreset)
themeRoutes.delete('/api/theme/presets/:id', ctrl.deletePreset)
