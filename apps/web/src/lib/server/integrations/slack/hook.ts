/**
 * Slack hook handler.
 * Sends messages to Slack channels when events occur.
 */

import { WebClient } from '@slack/web-api'
import type { HookHandler, HookResult } from '../../events/hook-types'
import type { EventData } from '../../events/types'
import { isRetryableError } from '../../events/hook-utils'
import { buildSlackMessage, storageKeyFromUrl } from './message'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'slack' })

/**
 * Slack hook target.
 */
export interface SlackTarget {
  channelId: string
}

/**
 * Slack hook config.
 */
export interface SlackConfig {
  accessToken: string
  /** Portal base URL for constructing post links */
  rootUrl: string
}

// OAuth errors that indicate token is invalid/expired (don't retry these)
const AUTH_ERRORS = ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive']

/**
 * Extract Slack error code from various error formats.
 */
function getSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined

  const err = error as Record<string, unknown>
  const data = err.data as Record<string, unknown> | undefined

  return (data?.error ?? err.error ?? err.code) as string | undefined
}

/**
 * Check if an error is an OAuth authentication failure.
 */
function isAuthError(error: unknown): boolean {
  const code = getSlackErrorCode(error)
  return code !== undefined && AUTH_ERRORS.includes(code)
}

interface ImageBlock {
  type: 'image'
  image_url: string
  alt_text?: string
}

function isImageBlock(b: unknown): b is ImageBlock {
  return typeof b === 'object' && b !== null && (b as { type?: string }).type === 'image'
}

/**
 * Split a message's blocks into non-image blocks (kept in the posted message)
 * and the image blocks (uploaded separately as native Slack files).
 *
 * We upload images rather than pass `image_url`s because Slack fetches those
 * server-side and re-fetches them later — a stored `/api/storage/<key>` URL
 * fails for an internal-only portal, and presigned S3 URLs expire. Native file
 * uploads are hosted by Slack permanently and need no public bucket.
 */
function splitImageBlocks(blocks: unknown[] | undefined): {
  textBlocks: unknown[] | undefined
  imageBlocks: ImageBlock[]
} {
  if (!Array.isArray(blocks)) return { textBlocks: blocks, imageBlocks: [] }
  const imageBlocks = blocks.filter(isImageBlock)
  if (imageBlocks.length === 0) return { textBlocks: blocks, imageBlocks: [] }
  return { textBlocks: blocks.filter((b) => !isImageBlock(b)), imageBlocks }
}

/**
 * Upload changelog images to a channel as native Slack files, threaded under
 * the announcement message. Best-effort: a failed image is logged and skipped
 * so it never blocks the announcement itself. External/CDN images (not on our
 * storage route) are skipped — we only have bytes for our own storage keys.
 */
async function uploadImages(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  images: ImageBlock[]
): Promise<void> {
  const { isS3Configured, getS3Object } = await import('@/lib/server/storage/s3')
  if (!isS3Configured()) return

  for (const img of images) {
    const key = storageKeyFromUrl(img.image_url)
    if (!key) continue // external/CDN image — no local bytes to upload
    try {
      const { body } = await getS3Object(key)
      const buffer = Buffer.from(await new Response(body).arrayBuffer())
      const filename = key.split('/').pop() || 'image'
      const title = img.alt_text || filename
      // Split by thread vs channel destination: the SDK's union types
      // `thread_ts` as either a definite string or `never`, so it can't be
      // passed as `string | undefined`.
      if (threadTs) {
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          file: buffer,
          filename,
          title,
        })
      } else {
        await client.files.uploadV2({ channel_id: channelId, file: buffer, filename, title })
      }
    } catch (error) {
      log.warn({ err: error, key }, 'failed to upload changelog image to slack')
    }
  }
}

/**
 * Post a message to a channel, auto-joining public channels if needed.
 */
async function postMessage(
  client: WebClient,
  channelId: string,
  message: { text: string; blocks?: unknown[] }
): Promise<{ ok?: boolean; ts?: string; error?: string }> {
  try {
    return await client.chat.postMessage({
      channel: channelId,
      unfurl_links: false,
      unfurl_media: false,
      ...message,
    })
  } catch (error) {
    const errorCode = getSlackErrorCode(error)
    log.debug({ error_code: errorCode }, 'post message failed, evaluating retry')

    // If not in channel, try to join (only works for public channels)
    if (errorCode === 'not_in_channel' || errorCode === 'channel_not_found') {
      log.debug({ channel_id: channelId }, 'attempting to join channel')
      const joinResult = await client.conversations.join({ channel: channelId })

      if (!joinResult.ok) {
        log.warn({ channel_id: channelId, join_error: joinResult.error }, 'failed to join channel')
        throw new Error(
          `Cannot post to this channel. Please invite the bot to the channel first.`,
          { cause: error }
        )
      }

      log.debug({ channel_id: channelId }, 'joined channel, retrying message')
      return await client.chat.postMessage({
        channel: channelId,
        unfurl_links: false,
        unfurl_media: false,
        ...message,
      })
    }

    throw error
  }
}

export const slackHook: HookHandler = {
  async run(event: EventData, target: unknown, config: unknown): Promise<HookResult> {
    const { channelId } = target as SlackTarget
    const { accessToken, rootUrl } = config as SlackConfig

    log.debug({ event_type: event.type, channel_id: channelId }, 'processing hook event')

    const client = new WebClient(accessToken)
    const message = buildSlackMessage(event, rootUrl)
    // Images are uploaded as native Slack files after the message posts, not
    // embedded as image blocks (those need a Slack-reachable, non-expiring URL).
    const { textBlocks, imageBlocks } = splitImageBlocks(message.blocks)

    try {
      const result = await postMessage(client, channelId, { ...message, blocks: textBlocks })

      if (result.ok) {
        log.info({ channel_id: channelId, message_ts: result.ts }, 'posted message to channel')
        // Thread the images under the announcement. Best-effort — never fails
        // the hook, since the text has already been delivered.
        if (imageBlocks.length > 0) {
          await uploadImages(client, channelId, result.ts, imageBlocks)
        }
      } else {
        log.error({ channel_id: channelId, error_code: result.error }, 'failed to post message')
      }

      return {
        success: result.ok === true,
        externalId: result.ts,
        error: result.error,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      const errorCode = getSlackErrorCode(error)
      log.error({ err: error, error_code: errorCode }, 'hook delivery failed')

      // Auth errors should not be retried - they require reconnecting Slack
      if (isAuthError(error)) {
        return {
          success: false,
          error: `Authentication failed: ${errorCode}. Please reconnect Slack.`,
          shouldRetry: false,
        }
      }

      return {
        success: false,
        error: errorMsg,
        shouldRetry: isRetryableError(error),
      }
    }
  },

  async testConnection(config: unknown): Promise<{ ok: boolean; error?: string }> {
    const { accessToken } = config as SlackConfig
    try {
      const client = new WebClient(accessToken)
      const result = await client.auth.test()
      return { ok: result.ok === true, error: result.error }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' }
    }
  },
}
