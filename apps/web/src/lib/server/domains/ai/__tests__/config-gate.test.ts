import { describe, it, expect } from 'vitest'
import { isAiClientConfigured, isBedrockConfigured, collectAiConfigWarnings } from '../config'

/** Build an openai-provider snapshot with sensible defaults. */
function openaiSnap(over: {
  apiKey?: string
  baseUrl?: string
  chatModel?: string
  embeddingModel?: string
}) {
  return {
    provider: 'openai' as const,
    apiKey: over.apiKey,
    baseUrl: over.baseUrl,
    bedrockRegion: undefined,
    bedrockBaseUrl: undefined,
    chatModel: over.chatModel,
    embeddingModel: over.embeddingModel,
  }
}

/** Build a bedrock-provider snapshot with sensible defaults. */
function bedrockSnap(over: {
  bedrockRegion?: string
  bedrockBaseUrl?: string
  chatModel?: string
  embeddingModel?: string
}) {
  return {
    provider: 'bedrock' as const,
    apiKey: undefined,
    baseUrl: undefined,
    bedrockRegion: over.bedrockRegion,
    bedrockBaseUrl: over.bedrockBaseUrl,
    chatModel: over.chatModel,
    embeddingModel: over.embeddingModel,
  }
}

describe('isAiClientConfigured', () => {
  it('is true only when both api key and base url are set', () => {
    expect(isAiClientConfigured('sk-key', 'https://api.openai.com/v1')).toBe(true)
  })

  it('is false when base url is missing (no implicit api.openai.com)', () => {
    expect(isAiClientConfigured('sk-key', undefined)).toBe(false)
    expect(isAiClientConfigured('sk-key', '')).toBe(false)
  })

  it('is false when api key is missing', () => {
    expect(isAiClientConfigured(undefined, 'https://gateway.example/v1')).toBe(false)
  })
})

describe('isBedrockConfigured', () => {
  it('is true when a region is set (base url + credentials not required)', () => {
    expect(isBedrockConfigured('us-east-1')).toBe(true)
  })

  it('is false when region is missing', () => {
    expect(isBedrockConfigured(undefined)).toBe(false)
    expect(isBedrockConfigured('')).toBe(false)
  })
})

describe('collectAiConfigWarnings (openai)', () => {
  it('warns when api key is set but base url is missing', () => {
    const w = collectAiConfigWarnings(openaiSnap({ apiKey: 'sk' }))
    expect(w.some((m) => m.includes('OPENAI_BASE_URL'))).toBe(true)
  })

  it('warns when client is configured but no models are set', () => {
    const w = collectAiConfigWarnings(openaiSnap({ apiKey: 'sk', baseUrl: 'https://x/v1' }))
    expect(w.some((m) => m.includes('no models'))).toBe(true)
  })

  it('is silent when client and at least one model are configured', () => {
    const w = collectAiConfigWarnings(
      openaiSnap({ apiKey: 'sk', baseUrl: 'https://x/v1', chatModel: 'm' })
    )
    expect(w).toEqual([])
  })

  it('is silent when AI is entirely unconfigured', () => {
    const w = collectAiConfigWarnings(openaiSnap({}))
    expect(w).toEqual([])
  })
})

describe('collectAiConfigWarnings (bedrock)', () => {
  it('warns when no region is set', () => {
    const w = collectAiConfigWarnings(bedrockSnap({}))
    expect(w.some((m) => m.includes('AI_BEDROCK_REGION'))).toBe(true)
  })

  it('does not warn about base url (it is optional / derived from region)', () => {
    const w = collectAiConfigWarnings(bedrockSnap({ bedrockRegion: 'us-east-1', chatModel: 'm' }))
    expect(w.some((m) => m.includes('AI_BEDROCK_BASE_URL'))).toBe(false)
  })

  it('warns when region is set but no models are configured', () => {
    const w = collectAiConfigWarnings(bedrockSnap({ bedrockRegion: 'us-east-1' }))
    expect(w.some((m) => m.includes('no models'))).toBe(true)
  })

  it('is silent when region + a model are configured (no base url needed)', () => {
    const w = collectAiConfigWarnings(
      bedrockSnap({
        bedrockRegion: 'us-east-1',
        embeddingModel: 'amazon.titan-embed-text-v1',
      })
    )
    expect(w).toEqual([])
  })

  it('does not emit openai warnings for the bedrock provider', () => {
    const w = collectAiConfigWarnings(bedrockSnap({ bedrockRegion: 'us-east-1' }))
    expect(w.some((m) => m.includes('OPENAI_BASE_URL'))).toBe(false)
  })
})
