import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getModelCatalog, resolveCatalogModel } = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  resolveCatalogModel: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/model-catalog', () => ({
  getModelCatalog,
  resolveCatalogModel,
  catalogReasoningEfforts: (model: { reasoning?: boolean }) => model.reasoning ? ['low', 'high'] : [],
}))

import { createCatalogModelMetadataEnricher } from '../../packages/server/src/modules/hermes/services/models/metadata'

const models = Array.from({ length: 3000 }, (_, index) => `model-${index}`)
const group = { provider: 'custom:gateway', base_url: 'https://gateway.test/v1', models }

beforeEach(() => {
  vi.resetAllMocks()
  getModelCatalog.mockReturnValue({})
  resolveCatalogModel.mockImplementation((_catalog, query) => ({ model: { id: query.model, reasoning: true } }))
})

describe('bounded catalog metadata scans', () => {
  it('scans at most 100 models while retaining the complete list and existing metadata', () => {
    const model_meta = { 'model-2999': { alias: 'Last model', preview: true, disabled: true } }
    const [result] = createCatalogModelMetadataEnricher()([{ ...group, model_meta }])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(100)
    expect(result.models).toEqual(models)
    expect(result.model_meta['model-99']).toMatchObject({ reasoning: true, reasoning_efforts: ['low', 'high'] })
    expect(result.model_meta['model-100']).toBeUndefined()
    expect(result.model_meta['model-2999']).toEqual(model_meta['model-2999'])
    expect(model_meta).toEqual({ 'model-2999': { alias: 'Last model', preview: true, disabled: true } })
  })

  it('uses selected candidates beyond the first 100 source models without scanning hidden models', () => {
    const [result] = createCatalogModelMetadataEnricher(() => ['model-2999'])([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(1)
    expect(resolveCatalogModel).toHaveBeenCalledWith({}, {
      provider: group.provider, baseUrl: group.base_url, model: 'model-2999',
    })
    expect(result.models).toEqual(models)
    expect(Object.keys(result.model_meta!)).toEqual(['model-2999'])
  })

  it('shares the cap and cached hits across profiles and repeated response sections', () => {
    const enrich = createCatalogModelMetadataEnricher()
    enrich([{ ...group, models: models.slice(0, 70) }])
    enrich([{ ...group, models: models.slice(50, 150) }])
    const [repeated] = enrich([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(100)
    expect(Object.keys(repeated.model_meta!)).toHaveLength(100)
    enrich([{ ...group, provider: 'custom:other' }])
    expect(resolveCatalogModel).toHaveBeenCalledTimes(200)
  })

  it('counts and reuses misses, including duplicate model IDs', () => {
    resolveCatalogModel.mockReturnValue(undefined)
    const enrich = createCatalogModelMetadataEnricher()
    enrich([{ ...group, models: [...models.slice(0, 50), ...models.slice(0, 50)] }])
    enrich([group, group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(100)
  })

  it('keeps endpoint-dependent metadata separate within one provider budget', () => {
    resolveCatalogModel.mockImplementation((_catalog, query) => ({
      model: { reasoning: query.baseUrl === group.base_url },
    }))
    const enrich = createCatalogModelMetadataEnricher()
    const [first, second] = enrich([
      { ...group, models: models.slice(0, 60) },
      { ...group, base_url: 'https://other.test/v1', models: models.slice(0, 60) },
    ])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(100)
    expect(first.model_meta?.['model-0'].reasoning).toBe(true)
    expect(second.model_meta?.['model-0'].reasoning).toBe(false)
    expect(second.model_meta?.['model-40']).toBeUndefined()
  })

  it('starts a fresh budget and catalog snapshot for each response', () => {
    createCatalogModelMetadataEnricher()([group])
    const nextCatalog = { refreshed: true }
    getModelCatalog.mockReturnValue(nextCatalog)
    resolveCatalogModel.mockReturnValue({ model: { reasoning: false } })
    const [next] = createCatalogModelMetadataEnricher()([group])

    expect(resolveCatalogModel).toHaveBeenCalledTimes(200)
    expect(resolveCatalogModel.mock.calls[100][0]).toBe(nextCatalog)
    expect(next.model_meta?.['model-0'].reasoning).toBe(false)
  })

  it('leaves the list intact when the catalog has not loaded', () => {
    getModelCatalog.mockReturnValue(null)
    expect(createCatalogModelMetadataEnricher()([group])).toEqual([group])
    expect(resolveCatalogModel).not.toHaveBeenCalled()
  })
})
