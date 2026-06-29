/**
 * Provider-neutral embedding generation.
 *
 * Returns a 1536-dim vector (matching the pgvector columns) plus token usage,
 * hiding two backends:
 *   - openai:  Embeddings API (`embeddings.create`), with explicit dimensions.
 *   - bedrock: Amazon Titan Text Embeddings v1 via the native Bedrock runtime
 *     `InvokeModel` API (fixed 1536 dims, no `dimensions` param).
 *
 * Callers wrap this in withRetry/withUsageLogging as today; this module only
 * performs the single provider call and normalizes the result.
 */

import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { config } from '@/lib/server/config'
import { getOpenAI, getAiProvider } from './config'
import { getBedrockRuntime } from './bedrock-runtime'

/** Fixed embedding width; matches the `vector(1536)` columns and Titan v1. */
export const EMBEDDING_DIMENSIONS = 1536

export interface EmbeddingVectorResult {
  embedding: number[]
  usage: { inputTokens: number; totalTokens: number }
}

interface TitanEmbeddingResponse {
  embedding: number[]
  inputTextTokenCount?: number
}

/**
 * Generate an embedding vector for `text` with the given model.
 * Returns `null` when no AI client is configured.
 */
export async function createEmbeddingVector(
  model: string,
  text: string
): Promise<EmbeddingVectorResult | null> {
  if (getAiProvider() === 'bedrock') {
    // The native runtime client derives its own endpoint from the region;
    // AI_BEDROCK_BASE_URL is a chat-only override and not needed here.
    if (!config.aiBedrockRegion) return null

    const command = new InvokeModelCommand({
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text }),
    })
    const response = await getBedrockRuntime().send(command)
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbeddingResponse
    const tokens = parsed.inputTextTokenCount ?? 0
    return {
      embedding: parsed.embedding,
      usage: { inputTokens: tokens, totalTokens: tokens },
    }
  }

  const openai = getOpenAI()
  if (!openai) return null

  const response = await openai.embeddings.create({
    model,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return {
    embedding: response.data[0]?.embedding ?? [],
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  }
}
