/**
 * Tests for the provider-neutral embedding client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let provider: 'openai' | 'bedrock' = 'openai'
const mockConfig: {
  aiBedrockRegion?: string
  aiBedrockBaseUrl?: string
  aiBedrockApiKey?: string
} = {}
const embeddingsCreate = vi.fn()
const bedrockSend = vi.fn()

vi.mock('@/lib/server/config', () => ({
  config: {
    get aiBedrockRegion() {
      return mockConfig.aiBedrockRegion
    },
    get aiBedrockBaseUrl() {
      return mockConfig.aiBedrockBaseUrl
    },
    get aiBedrockApiKey() {
      return mockConfig.aiBedrockApiKey
    },
  },
}))
vi.mock('../config', () => ({
  getOpenAI: () => ({ embeddings: { create: embeddingsCreate } }),
  getAiProvider: () => provider,
}))
vi.mock('../bedrock-runtime', () => ({
  getBedrockRuntime: () => ({ send: bedrockSend }),
  getBedrockCredentials: () => () => ({}),
}))
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  InvokeModelCommand: class {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  },
}))

describe('createEmbeddingVector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    provider = 'openai'
    mockConfig.aiBedrockRegion = 'us-east-1'
    mockConfig.aiBedrockBaseUrl = 'https://mantle'
    mockConfig.aiBedrockApiKey = undefined
  })

  it('openai: passes dimensions and maps usage', async () => {
    embeddingsCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    })
    const { createEmbeddingVector, EMBEDDING_DIMENSIONS } = await import('../embedding-client')
    const result = await createEmbeddingVector('text-embedding-3-small', 'hello')

    const arg = embeddingsCreate.mock.calls[0][0]
    expect(arg.dimensions).toBe(EMBEDDING_DIMENSIONS)
    expect(arg.input).toBe('hello')
    expect(result).toEqual({
      embedding: [0.1, 0.2],
      usage: { inputTokens: 4, totalTokens: 4 },
    })
  })

  it('bedrock: invokes Titan with inputText body and no dimensions, maps token count', async () => {
    provider = 'bedrock'
    bedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({ embedding: [1, 2, 3], inputTextTokenCount: 9 })
      ),
    })
    const { createEmbeddingVector } = await import('../embedding-client')
    const result = await createEmbeddingVector('amazon.titan-embed-text-v1', 'hello')

    const command = bedrockSend.mock.calls[0][0]
    expect(command.input.modelId).toBe('amazon.titan-embed-text-v1')
    expect(command.input.dimensions).toBeUndefined()
    expect(JSON.parse(command.input.body)).toEqual({ inputText: 'hello' })
    expect(result).toEqual({
      embedding: [1, 2, 3],
      usage: { inputTokens: 9, totalTokens: 9 },
    })
  })

  it('bedrock: works without a base url (region-only); base url is chat-only', async () => {
    provider = 'bedrock'
    mockConfig.aiBedrockBaseUrl = undefined
    bedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [1], inputTextTokenCount: 1 })),
    })
    const { createEmbeddingVector } = await import('../embedding-client')
    const result = await createEmbeddingVector('amazon.titan-embed-text-v1', 'hello')
    expect(result).toEqual({ embedding: [1], usage: { inputTokens: 1, totalTokens: 1 } })
  })

  it('bedrock: returns null when region is unset', async () => {
    provider = 'bedrock'
    mockConfig.aiBedrockRegion = undefined
    const { createEmbeddingVector } = await import('../embedding-client')
    const result = await createEmbeddingVector('amazon.titan-embed-text-v1', 'hello')
    expect(result).toBeNull()
  })
})
