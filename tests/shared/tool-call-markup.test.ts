import { describe, expect, it } from 'vitest'
import { filterToolCallMarkup, flushToolCallMarkup, stripToolCallMarkup } from '../../packages/shared/tool-call-markup'

const protocol = '<tool_call><invoke name="read_file"><parameter name="path">demo.txt</parameter></invoke></tool_call>'

describe('text-channel protocol filtering', () => {
  it('removes protocol blocks while retaining the answer', () => {
    expect(stripToolCallMarkup(`Before\n${protocol}\nAfter`)).toBe('Before\n\nAfter')
  })

  it('handles every possible two-chunk split', () => {
    for (let split = 0; split <= protocol.length; split++) {
      const state = {}
      const text = filterToolCallMarkup(state, protocol.slice(0, split))
        + filterToolCallMarkup(state, protocol.slice(split) + '\nDone')
        + flushToolCallMarkup(state)
      expect(text).toBe('\nDone')
    }
  })

  it('keeps code examples, inline discussion and ordinary XML', () => {
    const text = `Explain <tool_call> here.\n\`${protocol}\`\n\`\`\`xml\n${protocol}\n\`\`\`\n<article>Hello</article>`
    expect(stripToolCallMarkup(text)).toBe(text)
  })

  it('bounds discarded argument memory and drops unfinished protocol without executing it', () => {
    const state = {}
    filterToolCallMarkup(state, '<tool_call>' + 'x'.repeat(500_000))
    expect(JSON.stringify(state).length).toBeLessThan(200)
    expect(flushToolCallMarkup(state)).toBe('')
    expect(stripToolCallMarkup('A comparison\n<')).toBe('A comparison\n<')
  })

  it('handles the function-call wrappers and DSML shape', () => {
    for (const [open, close] of [
      ['<function_calls>', '</function_calls>'],
      ['<｜DSML｜function_calls>', '</｜DSML｜function_calls>'],
    ]) expect(stripToolCallMarkup(`${open}<invoke name="test">payload</invoke>${close}\nDone`)).toBe('\nDone')
  })
})
