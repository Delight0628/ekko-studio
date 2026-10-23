export const STUDIO_ERROR_CODES = [
  'INVALID_ARGUMENT', 'FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT',
  'SYSTEM_PLUGIN_PROTECTED', 'PLUGIN_UNAVAILABLE', 'PLUGIN_VERSION_INCOMPATIBLE',
  'REGISTRATION_CONFLICT', 'CAPABILITY_UNSUPPORTED', 'RUNTIME_UNAVAILABLE',
  'CANCELLED', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'INTERNAL',
] as const
export type StudioErrorCode = typeof STUDIO_ERROR_CODES[number]

export interface StudioErrorData {
  code: StudioErrorCode
  message: string
  retryable: boolean
}

export class StudioError extends Error implements StudioErrorData {
  constructor(
    public readonly code: StudioErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'StudioError'
  }

  toJSON(): StudioErrorData {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}
