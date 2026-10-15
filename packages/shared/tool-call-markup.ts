/** Remove leaked protocol blocks, never execute them. Markdown code remains literal. */
export interface ToolCallMarkupState {
  pending?: string
  closing?: string
  tail?: string
  lineStart?: boolean
  ticks?: number
  codeTicks?: number
  tickChar?: string
  codeChar?: string
}

const blocks = [
  ['<tool_call>', '</tool_call>'],
  ['<function_calls>', '</function_calls>'],
  ['<invoke name=', '</invoke>'],
  ['<｜DSML｜function_calls>', '</｜DSML｜function_calls>'],
] as const

export function filterToolCallMarkup(state: ToolCallMarkupState, delta: string): string {
  let out = ''
  if (state.lineStart === undefined) state.lineStart = true
  for (const char of delta) {
    if (state.closing) {
      state.tail = `${state.tail || ''}${char}`.slice(-state.closing.length)
      if (state.tail === state.closing) {
        state.closing = undefined
        state.tail = ''
        state.lineStart = true
      }
      continue
    }
    if (state.pending !== undefined) {
      state.pending += char
      const match = blocks.find(([opening]) => state.pending === opening)
      if (match) {
        state.closing = match[1]
        state.pending = undefined
        continue
      }
      if (blocks.some(([opening]) => opening.startsWith(state.pending!))) continue
      out += state.pending
      state.lineStart = char === '\n'
      state.pending = undefined
      continue
    }
    if ((char === '`' || char === '~') && (!state.ticks || state.tickChar === char)) {
      state.ticks = (state.ticks || 0) + 1
      state.tickChar = char
      out += char
      continue
    }
    if (state.ticks) {
      if (!state.codeTicks && (state.tickChar === '`' || state.ticks >= 3)) {
        state.codeTicks = state.ticks
        state.codeChar = state.tickChar
      } else if (state.ticks === state.codeTicks && state.tickChar === state.codeChar) state.codeTicks = 0
      state.ticks = 0
    }
    if (!state.codeTicks && state.lineStart && char === '<') {
      state.pending = '<'
      continue
    }
    out += char
    if (char === '\n') state.lineStart = true
    else if (char !== ' ' && char !== '\t') state.lineStart = false
  }
  return out
}

export function flushToolCallMarkup(state: ToolCallMarkupState): string {
  const text = state.closing ? '' : state.pending || ''
  state.pending = undefined
  state.closing = undefined
  state.tail = ''
  state.ticks = 0
  state.codeTicks = 0
  state.tickChar = undefined
  state.codeChar = undefined
  state.lineStart = true
  return text
}

export function stripToolCallMarkup(text: string): string {
  const state: ToolCallMarkupState = {}
  return filterToolCallMarkup(state, text) + flushToolCallMarkup(state)
}
