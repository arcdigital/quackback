/**
 * Tests for the Bedrock custom fetch (bearer vs SigV4).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mutable config stand-in so each test can pick the auth mode.
const mockConfig: { aiBedrockApiKey?: string; aiBedrockRegion?: string } = {}
vi.mock('@/lib/server/config', () => ({
  config: {
    get aiBedrockApiKey() {
      return mockConfig.aiBedrockApiKey
    },
    get aiBedrockRegion() {
      return mockConfig.aiBedrockRegion
    },
  },
}))

// Capture what the signer received; return deterministic signed headers.
const signMock = vi.fn()
vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class {
    sign = signMock
  },
}))
vi.mock('../bedrock-runtime', () => ({ getBedrockCredentials: () => () => ({}) }))
vi.mock('@aws-crypto/sha256-js', () => ({ Sha256: class {} }))

describe('createBedrockFetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.aiBedrockApiKey = undefined
    mockConfig.aiBedrockRegion = 'us-east-1'
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bearer mode: sets Authorization header and does not sign', async () => {
    mockConfig.aiBedrockApiKey = 'bedrock-key-123'
    const { createBedrockFetch } = await import('../bedrock-fetch')
    const doFetch = createBedrockFetch()

    await doFetch('https://mantle.example/openai/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"gpt-5.5"}',
    })

    expect(signMock).not.toHaveBeenCalled()
    const [, init] = fetchSpy.mock.calls[0]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer bedrock-key-123')
  })

  it('sigv4 mode: signs an HttpRequest preserving the non-standard responses path', async () => {
    signMock.mockResolvedValue({
      method: 'POST',
      headers: { authorization: 'AWS4-HMAC-SHA256 ...', host: 'mantle.example' },
    })
    const { createBedrockFetch } = await import('../bedrock-fetch')
    const doFetch = createBedrockFetch()

    await doFetch('https://mantle.example/openai/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"gpt-5.5"}',
    })

    expect(signMock).toHaveBeenCalledOnce()
    const signedReq = signMock.mock.calls[0][0]
    expect(signedReq.path).toBe('/openai/v1/responses')
    expect(signedReq.hostname).toBe('mantle.example')
    expect(signedReq.headers.host).toBe('mantle.example')
    expect(signedReq.body).toBe('{"model":"gpt-5.5"}')

    // The signed headers are forwarded to the real fetch.
    const [, init] = fetchSpy.mock.calls[0]
    expect(init.headers.authorization).toBe('AWS4-HMAC-SHA256 ...')
  })

  it('sigv4 mode: throws when region is missing', async () => {
    mockConfig.aiBedrockRegion = undefined
    const { createBedrockFetch } = await import('../bedrock-fetch')
    expect(() => createBedrockFetch()).toThrow(/AI_BEDROCK_REGION/)
  })
})
