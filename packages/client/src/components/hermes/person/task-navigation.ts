import type { InjectionKey } from 'vue'

export const personTaskNavigation: InjectionKey<(taskId: string) => void> = Symbol('personTaskNavigation')
