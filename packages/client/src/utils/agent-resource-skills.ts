import type { SkillFileEntry, SkillsData } from '@/api/hermes/skills'
import { readAgentResource, writeAgentResource, type AgentResourceCatalog, type AgentResourceContent, type AgentResourceInstance } from '@/api/studio/agent-resources'

export interface ResourceSkillsAdapter {
  loadSkills(): Promise<SkillsData>
  loadContent(category: string, skill: string, path?: string): Promise<string>
  loadFiles(category: string, skill: string): Promise<SkillFileEntry[]>
  saveContent(category: string, skill: string, content: string, path?: string): Promise<void>
  canEditFile(category: string, skill: string, path: string): boolean
}
export function resourceSkillsAdapter(instance: AgentResourceInstance, profile: string, catalog: AgentResourceCatalog): ResourceSkillsAdapter {
  const loaded = new Map<string, AgentResourceContent>()
  const skillPath = (skill: string, path = 'SKILL.md') => skill === '.' ? path : `${skill}/${path}`
  const key = (category: string, skill: string, path = 'SKILL.md') => JSON.stringify([category, skill, path])
  return {
    async loadSkills() {
      return { archived: [], categories: (catalog.skills || []).map(location => ({
        name: location.id, description: `${location.name} · ${location.path}`,
        skills: catalog.files.filter(file => file.kind === 'skills' && file.locationId === location.id && (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))).map(file => ({
          name: file.path === 'SKILL.md' ? '.' : file.path.slice(0, -'/SKILL.md'.length),
          description: file.absolutePath, enabled: true, readonly: file.readOnly,
          source: location.scope === 'builtin' ? 'builtin' as const : 'local' as const,
          sourcePath: location.path,
        })),
      })) }
    },
    async loadContent(category, skill, path) {
      const result = await readAgentResource(instance, profile, catalog.snapshot, { kind: 'skills', locationId: category, path: skillPath(skill, path) })
      loaded.set(key(category, skill, path), result)
      return result.content
    },
    async loadFiles(category, skill) {
      const prefix = skill === '.' ? '' : `${skill}/`
      return catalog.files.filter(file => file.kind === 'skills' && file.locationId === category && file.path.startsWith(prefix))
        .map(file => ({ path: file.path.slice(prefix.length), name: file.path.slice(prefix.length), isDir: false }))
    },
    canEditFile(category, skill, path) {
      return catalog.files.some(file => file.kind === 'skills' && file.locationId === category && file.path === skillPath(skill, path) && !file.readOnly)
    },
    async saveContent(category, skill, content, path) {
      const file = loaded.get(key(category, skill, path))
      if (!file) throw new Error('Reload the skill before saving')
      loaded.set(key(category, skill, path), await writeAgentResource(instance, profile, catalog.snapshot, file, content))
    },
  }
}
