/** Remove leaked protocol blocks, never execute them. Markdown code remains literal. */
export interface ToolCallMarkupState {
  pending?: string
  closing?: string
  tail?: string
  lineStart?: boolean
  ticks?: number
  codeTicks?: number
  tickChar?: string
  tickLineStart?: boolean
  indent?: number
  escaped?: boolean
  fenceTicks?: number
  fenceChar?: string
  fenceCandidate?: number
  fenceTrailing?: boolean
  fenceOpening?: boolean
  indentedCodeAllowed?: boolean
  indentedCode?: boolean
}

const blocks = [
  ['<tool_call>', '</tool_call>'],
  ['<function_calls>', '</function_calls>'],
  ['<｜DSML｜function_calls>', '</｜DSML｜function_calls>'],
  ['</parameter>', ''],
  ['</invoke>', ''],
  ['</tool_call>', ''],
  ['</function_calls>', ''],
] as const

function openingMatch(text: string): { closing?: string, pending: boolean } {
  const exact = blocks.find(([opening]) => opening === text)
  if (exact) return { closing: exact[1], pending: false }
  if (blocks.some(([opening]) => opening.startsWith(text))) return { pending: true }
  for (const tag of ['invoke', 'parameter']) {
    const opening = `<${tag}`
    if (opening.startsWith(text)) return { pending: true }
    if (!text.startsWith(opening)) continue
    const rest = text.slice(opening.length)
    if (/^\s+name\s*=$/.test(rest)) return { closing: `</${tag}>`, pending: false }
    if (/^\s+(?:n|na|nam|name\s*)?$/.test(rest)) return { pending: true }
  }
  return { pending: false }
}

function advanceLine(state: ToolCallMarkupState, char: string): void {
  if (char === '\n') {
    // An indented code block starts after a blank line (or at document start),
    // and may continue on subsequent indented lines. Paragraph continuations
    // keep the existing whitespace-tolerant protocol filtering.
    state.indentedCodeAllowed = !!state.lineStart || !!state.indentedCode
    state.indentedCode = false
    state.lineStart = true
    state.indent = 0
  } else if (state.lineStart && (char === ' ' || char === '\t')) {
    const indent = state.indent || 0
    state.indent = indent + (char === '\t' ? 4 - indent % 4 : 1)
  } else {
    state.lineStart = false
  }
}

function advanceFence(state: ToolCallMarkupState, char: string): void {
  // Unlike inline backticks, fences close only on a line containing a matching
  // marker run (at least as long as the opener) and optional trailing whitespace.
  const count = state.fenceCandidate || 0
  if (char === '\n') {
    if (count >= state.fenceTicks!) {
      state.fenceTicks = undefined
      state.fenceChar = undefined
    }
    state.fenceCandidate = 0
    state.fenceTrailing = false
  } else if (count >= 0) {
    if (state.lineStart && (char === ' ' || char === '\t')) {
      // Indentation is checked when the first fence character arrives.
    } else if (char === state.fenceChar && !state.fenceTrailing
      && (state.lineStart || count > 0) && (state.indent || 0) <= 3) {
      state.fenceCandidate = count + 1
    } else if ((char === ' ' || char === '\t' || char === '\r') && count >= state.fenceTicks!) {
      state.fenceTrailing = true
    } else {
      state.fenceCandidate = -1
    }
  }
  advanceLine(state, char)
}

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
        state.indent = 0
      }
      continue
    }
    if (state.pending !== undefined) {
      state.pending += char
      const match = openingMatch(state.pending)
      if (match.closing !== undefined) {
        state.closing = match.closing || undefined
        state.pending = undefined
        continue
      }
      if (match.pending) continue
      // Reprocess the mismatching character so backticks/newlines still affect
      // Markdown state after an ordinary '<...'.
      out += state.pending.slice(0, -1)
      state.lineStart = false
      state.pending = undefined
    }
    if (state.indentedCode || (state.lineStart && (state.indent || 0) >= 4
      && state.indentedCodeAllowed !== false && char !== '\n')) {
      state.indentedCode = true
      out += char
      advanceLine(state, char)
      continue
    }
    if (state.ticks && char !== state.tickChar) {
      if (state.codeTicks) {
        if (state.tickChar === '`' && state.ticks === state.codeTicks) state.codeTicks = 0
      } else if (state.tickLineStart && state.ticks >= 3) {
        state.fenceTicks = state.ticks
        state.fenceChar = state.tickChar
        state.fenceCandidate = -1 // The opening line cannot also close a fence.
        state.fenceOpening = state.tickChar === '`'
      } else if (state.tickChar === '`') {
        state.codeTicks = state.ticks
      }
      state.ticks = 0
    }
    // A backtick in the info string invalidates a backtick fence opener.
    // The already-emitted prefix is instead an inline span whose delimiter
    // must be matched exactly, e.g. a line containing ```inline```.
    if (state.fenceOpening && char === '`') {
      state.codeTicks = state.fenceTicks
      state.fenceTicks = undefined
      state.fenceChar = undefined
      state.fenceOpening = false
    }
    if (char === '\n') state.fenceOpening = false
    if (state.fenceTicks) {
      out += char
      advanceFence(state, char)
      continue
    }
    if ((char === '`' || char === '~') && (!state.escaped || state.codeTicks)) {
      if (!state.ticks) state.tickLineStart = !!state.lineStart && (state.indent || 0) <= 3
      state.ticks = (state.ticks || 0) + 1
      state.tickChar = char
      out += char
      advanceLine(state, char)
      continue
    }
    if (!state.codeTicks && state.lineStart && char === '<') {
      state.pending = '<'
      continue
    }
    out += char
    advanceLine(state, char)
    state.escaped = !state.codeTicks && char === '\\' && !state.escaped
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
  state.tickLineStart = undefined
  state.indent = 0
  state.escaped = false
  state.fenceTicks = undefined
  state.fenceChar = undefined
  state.fenceCandidate = undefined
  state.fenceTrailing = false
  state.fenceOpening = false
  state.indentedCodeAllowed = true
  state.indentedCode = false
  state.lineStart = true
  return text
}

export function stripToolCallMarkup(text: string): string {
  const state: ToolCallMarkupState = {}
  return filterToolCallMarkup(state, text) + flushToolCallMarkup(state)
}
