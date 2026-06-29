/**
 * Help Center Embedding Service
 *
 * Generates embeddings for knowledge base articles using the same
 * configured embedding model as the feedback pipeline.
 */

import { db, helpCenterArticles, eq, sql } from '@/lib/server/db'
import { getEmbeddingModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { createEmbeddingVector } from '@/lib/server/domains/ai/embedding-client'
import type { HelpCenterArticleId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'help-center-embedding' })

/**
 * Format article text for embedding input.
 *
 * Title is repeated twice for emphasis (higher weight in similarity).
 * Category name is appended as context when available.
 * Total output is truncated to 8000 chars to avoid token limits.
 */
export function formatArticleText(title: string, content: string, categoryName?: string): string {
  const parts = [title, title, content || '']
  if (categoryName) parts.push(`Category: ${categoryName}`)
  return parts.join('\n\n').slice(0, 8000)
}

/**
 * Generate embedding for text using the configured embedding model.
 */
export async function generateKbEmbedding(text: string): Promise<number[] | null> {
  const model = getEmbeddingModel()
  if (!model) return null

  try {
    const { result: response } = await withRetry(() => createEmbeddingVector(model, text))
    return response?.embedding ?? null
  } catch (error) {
    log.error({ err: error }, 'article embedding generation failed')
    return null
  }
}

/**
 * Generate embedding for an article and save it to the database.
 */
export async function generateArticleEmbedding(
  articleId: string,
  title: string,
  content: string,
  categoryName?: string
): Promise<boolean> {
  const text = formatArticleText(title, content, categoryName)
  const embedding = await generateKbEmbedding(text)
  if (!embedding) return false

  const vectorStr = `[${embedding.join(',')}]`
  await db
    .update(helpCenterArticles)
    .set({
      embedding: sql`${vectorStr}::vector`,
      embeddingModel: getEmbeddingModel() ?? 'unknown',
      embeddingUpdatedAt: new Date(),
    })
    .where(eq(helpCenterArticles.id, articleId as HelpCenterArticleId))

  return true
}
