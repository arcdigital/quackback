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

/**
 * Rewrite image block URLs to directly-fetchable presigned S3 URLs.
 *
 * Slack downloads `image_url`s server-side from the public internet, so a
 * stored `.../api/storage/<key>` URL fails when the portal is internal-only.
 * Presigning points Slack straight at S3 (publicly reachable) with a
 * time-limited signature — Slack copies the image immediately, so the default
 * 48h expiry is ample. Blocks whose URL isn't a storage-route URL (external/CDN
 * images) or whose key can't be presigned are left as-is.
 */
async function resolveImageBlockUrls(
  blocks: unknown[] | undefined
): Promise<unknown[] | undefined> {
  if (!Array.isArray(blocks)) return blocks
  const hasImages = blocks.some(
    (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'image'
  )
  if (!hasImages) return blocks

  const { isS3Configured, generatePresignedGetUrl } = await import('@/lib/server/storage/s3')
  if (!isS3Configured()) return blocks

  return Promise.all(
    blocks.map(async (b) => {
      if (typeof b !== 'object' || b === null) return b
      const block = b as { type?: string; image_url?: string }
      if (block.type !== 'image' || typeof block.image_url !== 'string') return b
      const key = storageKeyFromUrl(block.image_url)
      if (!key) return b // external/CDN URL — already directly fetchable
      try {
        return { ...block, image_url: await generatePresignedGetUrl(key) }
      } catch (error) {
        log.warn({ err: error, key }, 'failed to presign changelog image, leaving url as-is')
        return b
      }
    })
  )
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

    // `invalid_blocks` is usually Slack failing to download an image block
    // server-side (private/unreachable portal, expired presign, etc). One bad
    // image would otherwise drop the whole announcement, so retry once without
    // any image blocks — the text + formatting still gets delivered.
    const hasImageBlock =
      Array.isArray(message.blocks) &&
      message.blocks.some(
        (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'image'
      )
    if (errorCode === 'invalid_blocks' && hasImageBlock) {
      const fallback = {
        ...message,
        blocks: message.blocks!.filter(
          (b) => !(typeof b === 'object' && b !== null && (b as { type?: string }).type === 'image')
        ),
      }
      log.warn(
        { channel_id: channelId },
        'invalid_blocks with images present, retrying without image blocks'
      )
      return await client.chat.postMessage({
        channel: channelId,
        unfurl_links: false,
        unfurl_media: false,
        ...fallback,
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
    // Point Slack's server-side image fetch at presigned S3 URLs so images
    // render even when the portal itself is internal-only.
    message.blocks = await resolveImageBlockUrls(message.blocks)

    try {
      const result = await postMessage(client, channelId, message)

      if (result.ok) {
        log.info({ channel_id: channelId, message_ts: result.ts }, 'posted message to channel')
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
