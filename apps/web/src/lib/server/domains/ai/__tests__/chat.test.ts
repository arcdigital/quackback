/**
 * Tests for the provider-neutral chat completion helper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let provider: 'openai' | 'bedrock' = 'openai'
const chatCreate = vi.fn()
const responsesCreate = vi.fn()
let client: unknown = {
  chat: { completions: { create: chatCreate } },
  responses: { create: responsesCreate },
}

vi.mock('../config', () => ({
  getOpenAI: () => client,
  getAiProvider: () => provider,
}))
// Keep retry/usage-logging real but trivial: db insert is mocked away.
vi.mock('@/lib/server/db', () => ({ db: { insert: () => ({ values: vi.fn() }) }, aiUsageLog: {} }))

describe('createChatCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    provider = 'openai'
    client = {
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    }
  })

  it('returns null when no client is configured', async () => {
    client = null
    const { createChatCompletion } = await import('../chat')
    const result = await createChatCompletion({ model: 'm', user: 'hi', maxOutputTokens: 100 })
    expect(result).toBeNull()
  })

  it('openai provider: calls chat.completions.create and maps text + usage', async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const { createChatCompletion } = await import('../chat')
    const result = await createChatCompletion({
      model: 'gpt-4o-mini',
      system: 'sys',
      user: 'hello',
      temperature: 0.2,
      maxOutputTokens: 1000,
    })

    expect(responsesCreate).not.toHaveBeenCalled()
    const arg = chatCreate.mock.calls[0][0]
    expect(arg.model).toBe('gpt-4o-mini')
    expect(arg.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
    expect(arg.response_format).toEqual({ type: 'json_object' })
    expect(arg.temperature).toBe(0.2)
    expect(arg.max_completion_tokens).toBe(1000)
    expect(result).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
  })

  it('bedrock provider: calls responses.create and maps output_text + usage', async () => {
    provider = 'bedrock'
    responsesCreate.mockResolvedValue({
      output_text: '{"ok":true}',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    })
    const { createChatCompletion } = await import('../chat')
    const result = await createChatCompletion({
      model: 'gpt-5.5',
      system: 'sys',
      user: 'hello',
      temperature: 0.1,
      maxOutputTokens: 2000,
    })

    expect(chatCreate).not.toHaveBeenCalled()
    const arg = responsesCreate.mock.calls[0][0]
    expect(arg.model).toBe('gpt-5.5')
    expect(arg.instructions).toBe('sys')
    expect(arg.input).toBe('hello')
    expect(arg.max_output_tokens).toBe(2000)
    // gpt-5.5 rejects temperature on the Responses API, so it must not be sent.
    expect(arg.temperature).toBeUndefined()
    expect(arg.text).toEqual({ format: { type: 'json_object' } })
    expect(result).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    })
  })

  it('omits response_format / text.format when jsonResponse is false', async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: 'plain' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const { createChatCompletion } = await import('../chat')
    await createChatCompletion({
      model: 'm',
      user: 'hi',
      jsonResponse: false,
      maxOutputTokens: 50,
    })
    expect(chatCreate.mock.calls[0][0].response_format).toBeUndefined()
  })
})
