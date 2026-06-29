/**
 * AI configuration and client management.
 *
 * Supports two providers, selected by AI_PROVIDER:
 *   - 'openai' (default): any OpenAI-compatible endpoint (direct provider, a
 *     model gateway, or a local server) declared via OPENAI_BASE_URL. AI is off
 *     unless both the API key and base URL are set.
 *   - 'bedrock': AWS Bedrock via bedrock-mantle. Chat uses the Responses API at
 *     the non-standard `openai/v1/responses` path (reached by pointing the SDK
 *     baseURL at `<AI_BEDROCK_BASE_URL>/openai/v1`); auth is a Bedrock API key
 *     (bearer) or the default AWS credential chain (SigV4), see ./bedrock-fetch.
 *
 * In both cases each feature additionally requires a configured model (see
 * ./models). There is no implicit endpoint default (see #180).
 */

import OpenAI from 'openai'
import { config } from '@/lib/server/config'
import { logger } from '@/lib/server/logger'
import { createBedrockFetch } from './bedrock-fetch'

const log = logger.child({ component: 'ai-config' })

let openai: OpenAI | null = null

/** The active AI provider. */
export function getAiProvider(): 'openai' | 'bedrock' {
  return config.aiProvider
}

/**
 * Whether an OpenAI-compatible client can be constructed. Requires BOTH an API
 * key and an explicit base URL — there is no implicit provider default (#180).
 */
export function isAiClientConfigured(
  apiKey: string | undefined,
  baseUrl: string | undefined
): boolean {
  return Boolean(apiKey) && Boolean(baseUrl)
}

/**
 * Whether a Bedrock client can be constructed. Requires only a region: the
 * chat host is derived from it (see resolveBedrockBaseUrl) and credentials come
 * from the default AWS provider chain (instance profile, EKS pod identity) or a
 * bearer key, resolved at call time.
 */
export function isBedrockConfigured(region: string | undefined): boolean {
  return Boolean(region)
}

/** Whether AI is configured for the active provider. */
export function isAiConfigured(): boolean {
  return config.aiProvider === 'bedrock'
    ? isBedrockConfigured(config.aiBedrockRegion)
    : isAiClientConfigured(config.openaiApiKey, config.openaiBaseUrl)
}

/** Join a base URL and a path segment with exactly one slash between them. */
function joinUrl(base: string, segment: string): string {
  return `${base.replace(/\/+$/, '')}/${segment.replace(/^\/+/, '')}`
}

/**
 * The bedrock-mantle chat host for a region, e.g.
 * `https://bedrock-mantle.us-east-1.api.aws`. gpt-5.5's Responses API lives at
 * the `/openai/v1/responses` path under this host (a sibling of the generic
 * `/v1/responses`); getOpenAI appends `openai/v1` and the SDK adds `/responses`.
 */
function defaultBedrockMantleHost(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`
}

/**
 * Resolve the Bedrock chat host root. AI_BEDROCK_BASE_URL overrides it (set the
 * host only, without a path); otherwise it's derived from the region. Returns
 * undefined when the region is unset.
 */
export function resolveBedrockBaseUrl(): string | undefined {
  const region = config.aiBedrockRegion
  if (!region) return undefined
  return config.aiBedrockBaseUrl ?? defaultBedrockMantleHost(region)
}

/**
 * Get the OpenAI-compatible client instance, or `null` when AI is not
 * configured. This is the single client guard for all AI functionality.
 * Callers handle `null` by returning early, falling back to a non-AI path,
 * or throwing `UnrecoverableError` (BullMQ workers).
 *
 * For Bedrock the client targets `<base>/openai/v1` so the SDK's `/responses`
 * suffix yields the required `openai/v1/responses` path, and a custom `fetch`
 * applies bearer or SigV4 auth (the `apiKey` here is an unused placeholder the
 * SDK requires to be non-empty).
 */
export function getOpenAI(): OpenAI | null {
  if (!isAiConfigured()) return null
  if (openai) return openai

  if (config.aiProvider === 'bedrock') {
    openai = new OpenAI({
      apiKey: 'bedrock-placeholder',
      baseURL: joinUrl(resolveBedrockBaseUrl() as string, 'openai/v1'),
      fetch: createBedrockFetch(),
    })
  } else {
    openai = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
    })
  }
  return openai
}

interface AiConfigSnapshot {
  provider: 'openai' | 'bedrock'
  apiKey: string | undefined
  baseUrl: string | undefined
  bedrockRegion: string | undefined
  bedrockBaseUrl: string | undefined
  chatModel: string | undefined
  embeddingModel: string | undefined
}

/**
 * Pure check for half-configured AI: returns human-readable warnings.
 * Silent when AI is fully off (nothing set) or correctly configured.
 */
export function collectAiConfigWarnings(snap: AiConfigSnapshot): string[] {
  const warnings: string[] = []

  if (snap.provider === 'bedrock') {
    // Region is the only required setting; the chat host is derived from it
    // (AI_BEDROCK_BASE_URL is an optional override). Without it the client
    // can't start, and a base URL alone isn't enough.
    if (!snap.bedrockRegion) {
      warnings.push(
        'AI disabled: AI_PROVIDER=bedrock but AI_BEDROCK_REGION is empty. Set AI_BEDROCK_REGION (or AWS_REGION).'
      )
      return warnings
    }
    if (!snap.chatModel && !snap.embeddingModel) {
      warnings.push(
        'AI endpoint configured but no models set; all AI features are disabled. Set AI_CHAT_MODEL and/or AI_EMBEDDING_MODEL.'
      )
    }
    return warnings
  }

  // Key set but no endpoint → the client can't start; the old implicit
  // provider default is gone (see #180).
  if (snap.apiKey && !snap.baseUrl) {
    warnings.push(
      'AI disabled: OPENAI_API_KEY is set but OPENAI_BASE_URL is empty. Set OPENAI_BASE_URL to your provider or gateway endpoint.'
    )
  }
  // Note: this checks role defaults only; a config that sets just a per-feature
  // override (e.g. AI_SUMMARY_MODEL) without a role default will still log this,
  // even though that one feature is enabled. Logs-only, so acceptable.
  if (snap.apiKey && snap.baseUrl && !snap.chatModel && !snap.embeddingModel) {
    warnings.push(
      'AI endpoint configured but no models set; all AI features are disabled. Set AI_CHAT_MODEL and/or AI_EMBEDDING_MODEL.'
    )
  }
  return warnings
}

/** Log AI config warnings once at boot. Never throws. */
export function validateAiConfig(): void {
  const warnings = collectAiConfigWarnings({
    provider: config.aiProvider,
    apiKey: config.openaiApiKey,
    baseUrl: config.openaiBaseUrl,
    bedrockRegion: config.aiBedrockRegion,
    bedrockBaseUrl: config.aiBedrockBaseUrl,
    chatModel: config.aiChatModel,
    embeddingModel: config.aiEmbeddingModel,
  })
  for (const w of warnings) log.warn({ warning: w }, 'ai config warning')
}

/** Strip markdown code fences that some models wrap around JSON responses. */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
}
