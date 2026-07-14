/**
 * Post a threaded reply back to the originating Slack message when feedback
 * captured from Slack (via the "Send to Quackback" action or channel
 * monitoring) is accepted into a published post.
 *
 * Best-effort: any failure is logged and swallowed so it never blocks the
 * accept flow. Server-only (imports @slack/web-api).
 */
import { WebClient } from '@slack/web-api'
import type { KnownBlock } from '@slack/web-api'
import { db, eq, and, integrations, boards } from '@/lib/server/db'
import { decryptSecrets } from '../encryption'
import { logger } from '@/lib/server/logger'
import { getBaseUrl } from '@/lib/server/config'
import { buildPostUrl } from '../message-utils'
import type { BoardId, PostId } from '@quackback/ids'

const log = logger.child({ component: 'slack' })

/**
 * Resolve the Slack thread coordinates from a raw feedback item's context
 * envelope, build the public post URL, and post a threaded reply. Any failure
 * is logged and swallowed so it never blocks the accept flow.
 */
export async function replyToSlackSource(
  contextEnvelope: unknown,
  boardId: BoardId,
  postId: PostId,
  title: string
): Promise<void> {
  try {
    const envelope = contextEnvelope as {
      sourceChannel?: { id?: string }
      metadata?: { messageTs?: string }
    } | null
    const channelId = envelope?.sourceChannel?.id
    const threadTs = envelope?.metadata?.messageTs
    if (!channelId || !threadTs) return

    // Resolve the board (name + slug for the URL) and workspace name in parallel.
    const [board, org] = await Promise.all([
      db.query.boards.findFirst({
        where: eq(boards.id, boardId),
        columns: { name: true, slug: true },
      }),
      db.query.settings.findFirst({ columns: { name: true } }),
    ])
    if (!board) return

    const postUrl = buildPostUrl(getBaseUrl(), board.slug, postId)
    await postSlackPostReply({
      channelId,
      threadTs,
      postUrl,
      postTitle: title,
      boardName: board.name,
      workspaceName: org?.name?.trim() || 'Quackback',
    })
  } catch (error) {
    log.warn({ err: error }, 'failed to resolve slack reply context')
  }
}

/**
 * Reply in-thread to a Slack message with a link to the created post.
 * Auto-joins the channel if the bot isn't a member (public channels only).
 */
export async function postSlackPostReply(opts: {
  channelId: string
  threadTs: string
  postUrl: string
  postTitle: string
  boardName: string
  workspaceName: string
}): Promise<void> {
  const { channelId, threadTs, postUrl, postTitle, boardName, workspaceName } = opts
  if (!channelId || !threadTs) return

  try {
    const integration = await db.query.integrations.findFirst({
      where: and(eq(integrations.integrationType, 'slack'), eq(integrations.status, 'active')),
      columns: { secrets: true },
    })
    if (!integration?.secrets) return

    const { accessToken } = decryptSecrets<{ accessToken: string }>(integration.secrets)
    const client = new WebClient(accessToken)

    // Plain-text fallback (notifications, screen readers, no-Block-Kit clients).
    const text = `🎉 Thanks for the feedback! We added "${postTitle}" to ${workspaceName} — track it here: ${postUrl}`
    const blocks: KnownBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎉 *Thanks for the feedback!* We turned this into a post on *${workspaceName}*:\n<${postUrl}|${postTitle}>`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `📋 Posted to *${boardName}*` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View post', emoji: true },
            url: postUrl,
            style: 'primary',
          },
        ],
      },
    ]

    const message = {
      channel: channelId,
      thread_ts: threadTs,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }

    try {
      await client.chat.postMessage(message)
    } catch (error) {
      // If the bot isn't in the channel, try to join (public channels only)
      // then retry once, mirroring the outbound-hook behavior.
      const errorCode =
        typeof error === 'object' && error !== null && 'data' in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined
      if (errorCode === 'not_in_channel' || errorCode === 'channel_not_found') {
        const joinResult = await client.conversations.join({ channel: channelId })
        if (joinResult.ok) {
          await client.chat.postMessage(message)
          return
        }
      }
      throw error
    }
  } catch (error) {
    log.warn({ err: error, channel_id: channelId }, 'failed to post slack post-created reply')
  }
}
