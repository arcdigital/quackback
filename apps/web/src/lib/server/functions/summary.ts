/**
 * Server functions for AI post summary operations.
 */

import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { PostId } from '@quackback/ids'
import { requireAuth } from './auth-helpers'
import { generateAndSavePostSummary } from '@/lib/server/domains/summary/summary.service'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'summary' })

const regenerateSummarySchema = z.object({
  postId: z.string(),
})

export type RegenerateSummaryInput = z.infer<typeof regenerateSummarySchema>

/**
 * Regenerate the AI summary for a post on demand.
 *
 * Unlike the event-driven and periodic-sweep paths, this lets an admin/member
 * force a refresh after editing the post's title or content — which otherwise
 * does not invalidate the existing summary.
 */
export const regeneratePostSummaryFn = createServerFn({ method: 'POST' })
  .validator(regenerateSummarySchema)
  .handler(async ({ data }) => {
    log.debug({ post_id: data.postId }, 'regenerate post summary')
    try {
      await requireAuth({ roles: ['admin', 'member'] })

      const generated = await generateAndSavePostSummary(data.postId as PostId)
      // `generated=false` means the work was skipped — most commonly because AI
      // is not configured. Report it so the caller can surface honest feedback
      // instead of a misleading success toast.
      return { success: true, generated }
    } catch (error) {
      log.error({ err: error }, 'regenerate post summary failed')
      throw error
    }
  })
