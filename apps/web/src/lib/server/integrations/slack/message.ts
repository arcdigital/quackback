/**
 * Slack message building utilities.
 * Creates Block Kit formatted messages for different event types.
 */

import type { EventData } from '../../events/types'
import { stripHtml, truncate, formatStatus, getStatusEmoji } from '../../events/hook-utils'
import { getAuthorName, buildPostUrl } from '../message-utils'

interface SlackMessage {
  text: string
  blocks?: unknown[]
}

const MRKDWN_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

/**
 * Escape special characters for Slack mrkdwn format.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/[&<>]/g, (char) => MRKDWN_ESCAPE_MAP[char] ?? char)
}

/**
 * Format text as a Slack quote block by prefixing each line with '>'.
 */
function quoteText(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * Render an ISO timestamp as a Slack `<!date>` token so each viewer sees it in
 * their own timezone/locale. Falls back to the UTC date if the string can't be
 * parsed. The `|fallback` after the token is what non-Slack surfaces (and the
 * notification `text`) show.
 */
function slackDate(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const epoch = Math.floor(ms / 1000)
  const fallback = new Date(ms).toISOString().slice(0, 10)
  return `<!date^${epoch}^{date_long}|${fallback}>`
}

/**
 * Extract markdown images (`![alt](url)`) in document order.
 * Run before markdownToMrkdwn, which strips images entirely.
 */
function extractImages(markdown: string): Array<{ alt: string; url: string }> {
  const out: Array<{ alt: string; url: string }> = []
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    out.push({ alt: m[1], url: m[2].trim() })
  }
  return out
}

/**
 * Extract the S3 storage key from a stored image URL that points at the
 * portal's storage route (`.../api/storage/<key>`), stripping any query string.
 * Returns null for URLs that aren't storage-route URLs (external/CDN images),
 * which the hook then leaves untouched.
 */
export function storageKeyFromUrl(url: string): string | null {
  const marker = '/api/storage/'
  const i = url.indexOf(marker)
  if (i === -1) return null
  const rest = url.slice(i + marker.length).split(/[?#]/)[0]
  if (!rest || rest.includes('..')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/**
 * Split mrkdwn text into chunks no longer than `max` (Slack's per-section text
 * limit is 3000). Prefers to break on a newline so formatting isn't split
 * mid-line; falls back to a hard cut for a single line longer than `max`.
 */
function chunkForSection(text: string, max = 2900): string[] {
  if (text.length <= max) return text ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * Convert stored markdown into Slack mrkdwn.
 *
 * Slack uses its own dialect, not CommonMark: bullets must be `•` (a leading
 * `- ` renders literally), bold is single-`*` (not `**`), headings have no
 * syntax, and links are `<url|text>`. It also can't be run through `stripHtml`,
 * whose whitespace collapse would flatten every list onto one line — so we
 * translate tokens while preserving line structure, then escape the angle
 * brackets Slack reserves (leaving the ones we emit for links intact).
 *
 * Kept intentionally small: it covers the formatting a changelog body actually
 * uses (headings, bold/italic, links, bullet/numbered lists), not the full
 * markdown grammar.
 */
function markdownToMrkdwn(markdown: string): string {
  const links: string[] = []
  let text = markdown
    // Drop any raw HTML tags, but keep newlines (unlike stripHtml, whose
    // whitespace collapse would flatten lists onto one line).
    .replace(/<[a-z!/][^>]*>?/gi, '')
    // Drop images entirely — Slack section text can't inline them.
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Stash links as placeholders so their URLs survive mrkdwn escaping below,
    // then restore them in Slack's `<url|text>` form. The placeholder uses only
    // characters escapeSlackMrkdwn leaves untouched, and is distinctive enough
    // not to collide with body text.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      links.push(`<${url}|${escapeSlackMrkdwn(label)}>`)
      return `@@LINK${links.length - 1}@@`
    })

  text = escapeSlackMrkdwn(text)
    // Strikethrough: `~~x~~` -> Slack's single-tilde `~x~`. Do this before the
    // italic pass so a lone `~` in body text is never mistaken for a marker.
    .replace(/~~(.+?)~~/g, '~$1~')
    // Underline: Slack mrkdwn has no underline syntax, so drop the `++x++`
    // markers and keep the inner text (rather than rendering them literally).
    .replace(/\+\+(.+?)\+\+/g, '$1')
    // Bold (`**x**`/`__x__`) and headings both render bold in Slack (single
    // `*x*`). Convert them to a sentinel first so the italic pass below — which
    // matches a single `*`/`_` — can't re-capture the emitted markers and
    // downgrade bold to italic.
    .replace(/(\*\*|__)(.+?)\1/g, '@@B@@$2@@B@@')
    // Headings render as bold. Strip any bold sentinels already inside the
    // heading text first: Slack has no nested bold, so `## Heading **x**` would
    // otherwise emit `*Heading *x* *` and render broken. The whole heading is
    // bold anyway, so inner bold is redundant.
    .replace(/^#{1,6}\s+(.*)$/gm, (_m, content: string) => {
      return `@@B@@${content.replace(/@@B@@/g, '')}@@B@@`
    })
    // Italic: `*x*`/`_x_` -> `_x_` (Slack italic marker).
    .replace(/(?<![*_])[*_](?![*_\s])(.+?)(?<![*_\s])[*_](?![*_])/g, '_$1_')
    // Restore bold sentinels now that the italic pass is done.
    .replace(/@@B@@/g, '*')
    // Bullet lists: leading `-`/`*`/`+` -> `•` (preserving indentation).
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    // Collapse runs of blank lines (e.g. left behind where images were removed)
    // to a single blank line, and trim leading/trailing whitespace.
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Restore link placeholders.
  return text.replace(/@@LINK(\d+)@@/g, (_m, i: string) => links[Number(i)] ?? '')
}

/**
 * Build a Slack message for an event.
 * @param event - The event data
 * @param rootUrl - Portal base URL for constructing post links
 */
export function buildSlackMessage(event: EventData, rootUrl: string): SlackMessage {
  switch (event.type) {
    case 'post.created': {
      const { post } = event.data
      const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
      const content = truncate(stripHtml(post.content), 300)
      const author = getAuthorName(post)

      return {
        text: `New feedback from ${author}: ${post.title}`,
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `📬 New feedback from *${escapeSlackMrkdwn(author)}*` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *<${postUrl}|${escapeSlackMrkdwn(post.title)}>*\n${quoteText(escapeSlackMrkdwn(content))}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `in <${rootUrl}/?board=${post.boardSlug}|${escapeSlackMrkdwn(post.boardSlug)}>`,
              },
            ],
          },
        ],
      }
    }

    case 'post.status_changed': {
      const { post, previousStatus, newStatus } = event.data
      const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
      const emoji = getStatusEmoji(newStatus)
      const actor = event.actor.email || 'System'

      return {
        text: `Status changed on "${post.title}": ${formatStatus(previousStatus)} → ${formatStatus(newStatus)}`,
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `${emoji} Status changed by *${escapeSlackMrkdwn(actor)}*` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *<${postUrl}|${escapeSlackMrkdwn(post.title)}>*\n> ${formatStatus(previousStatus)} → *${formatStatus(newStatus)}*`,
            },
          },
        ],
      }
    }

    case 'post.updated': {
      const { post, changedFields } = event.data
      const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
      const actor = event.actor.email || 'System'
      const fields = changedFields.join(', ')

      return {
        text: `Post updated by ${actor}: ${post.title}`,
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `✏️ Post updated by *${escapeSlackMrkdwn(actor)}*` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *<${postUrl}|${escapeSlackMrkdwn(post.title)}>*\n> Changed: ${escapeSlackMrkdwn(fields)}`,
            },
          },
        ],
      }
    }

    case 'post.deleted': {
      const { post } = event.data
      const actor = event.actor.email || 'System'

      return {
        text: `Post deleted by ${actor}: ${post.title}`,
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `🗑️ Post deleted by *${escapeSlackMrkdwn(actor)}*` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *${escapeSlackMrkdwn(post.title)}*`,
            },
          },
        ],
      }
    }

    case 'post.merged': {
      const { duplicatePost, canonicalPost } = event.data
      const canonicalUrl = buildPostUrl(rootUrl, canonicalPost.boardSlug, canonicalPost.id)
      const actor = event.actor.email || 'System'

      return {
        text: `Post merged by ${actor}: "${duplicatePost.title}" → "${canonicalPost.title}"`,
        blocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `🔀 Post merged by *${escapeSlackMrkdwn(actor)}*` }],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *${escapeSlackMrkdwn(duplicatePost.title)}* → *<${canonicalUrl}|${escapeSlackMrkdwn(canonicalPost.title)}>*`,
            },
          },
        ],
      }
    }

    case 'comment.created': {
      const { comment, post } = event.data
      const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
      const content = truncate(stripHtml(comment.content), 300)
      const author = getAuthorName(comment)

      return {
        text: `New comment from ${author} on "${post.title}"`,
        blocks: [
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `💬 New comment from *${escapeSlackMrkdwn(author)}*` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> *<${postUrl}|${escapeSlackMrkdwn(post.title)}>*\n${quoteText(escapeSlackMrkdwn(content))}`,
            },
          },
        ],
      }
    }

    case 'changelog.published': {
      const { changelog } = event.data
      const changelogUrl = `${rootUrl}/changelog/${changelog.id}`
      const actor = event.actor.displayName || event.actor.email || 'System'
      const publishedDate = slackDate(changelog.publishedAt)

      // Send the whole entry: prefer the full `content`, falling back to the
      // short preview for legacy/queued events that predate it.
      const source = changelog.content || changelog.contentPreview || ''
      // Images come from the payload (extracted from canonical contentJson).
      // Fall back to parsing the markdown body for legacy events without them.
      const images =
        changelog.images && changelog.images.length > 0
          ? changelog.images.map((i) => ({ url: i.src, alt: i.alt }))
          : extractImages(source)
      // Convert the markdown body to Slack mrkdwn (bullets, bold, links).
      // markdownToMrkdwn already escapes reserved characters and drops images,
      // so — unlike the title — its output must not be re-escaped.
      const body = markdownToMrkdwn(source)

      // Lead with a divider + header so consecutive changelog posts are clearly
      // separated and each title stands out (header renders large/bold, unlike a
      // plain bold section that blends into body text). Header blocks are
      // plain_text only — no link, 150-char cap — so the clickable link and the
      // "published by / date" line live in the context row beneath it.
      const headerText = truncate(`📢 ${changelog.title}`, 150)
      const metaParts = [`by *${escapeSlackMrkdwn(actor)}*`]
      if (publishedDate) metaParts.push(publishedDate)
      metaParts.push(`<${changelogUrl}|View changelog →>`)

      const blocks: unknown[] = [
        { type: 'divider' },
        { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: metaParts.join('  ·  ') }],
        },
      ]

      // Body split across sections to respect Slack's 3000-char text limit.
      for (const chunk of chunkForSection(body)) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } })
      }

      // Emit image blocks carrying the stored storage-route src. The Slack hook
      // extracts these (splitImageBlocks) and uploads the bytes as native Slack
      // files rather than sending them as image blocks — the storage URL is
      // internal-only and Slack fetches image_urls server-side. Cap at 8 (well
      // under Slack's 50-block limit).
      for (const img of images.slice(0, 8)) {
        blocks.push({
          type: 'image',
          image_url: img.url,
          alt_text: img.alt || 'changelog image',
        })
      }

      // Tags in a trailing context block, e.g. "🏷️ mobile · performance".
      const tags = (changelog.tags ?? []).filter((t) => t.trim().length > 0)
      if (tags.length > 0) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🏷️ ${tags.map((t) => escapeSlackMrkdwn(t)).join(' · ')}`,
            },
          ],
        })
      }

      return {
        text: `Changelog published: ${changelog.title}`,
        blocks,
      }
    }

    default:
      return { text: `Event: ${(event as { type: string }).type}` }
  }
}
