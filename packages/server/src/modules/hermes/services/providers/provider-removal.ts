// A removal belongs to this profile, even when its OAuth grant is inherited.
// It does not revoke another profile's authorization or remove a built-in preset.
export function isProviderRemoved(config: any, provider: string): boolean {
  return Array.isArray(config?.studio_removed_providers)
    && config.studio_removed_providers.includes(provider)
}

export function setProviderRemoved(config: any, provider: string, removed: boolean): void {
  const providers = new Set<string>(Array.isArray(config.studio_removed_providers)
    ? config.studio_removed_providers.filter((value: unknown) => typeof value === 'string')
    : [])
  if (removed) providers.add(provider)
  else providers.delete(provider)
  if (providers.size) config.studio_removed_providers = [...providers]
  else delete config.studio_removed_providers
}
