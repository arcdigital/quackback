/**
 * Jira inbound webhook handler.
 *
 * Receives webhook events from Jira and extracts status changes.
 * Signature: HMAC-SHA256 in `X-Hub-Signature` header (optional, Jira Cloud).
 * Status field: `changelog.items[]` where `field === 'status'` → `toString`.
 */

import { timingSafeEqual } from 'crypto'
import type { InboundWebhookHandler, InboundWebhookResult } from '../inbound-types'

export const jiraInboundHandler: InboundWebhookHandler = {
  // Jira Cloud's REST-registered ("dynamic") webhooks don't sign deliveries with
  // an X-Hub-Signature header (that's legacy admin webhooks only), so we can't
  // do HMAC verification. Instead the secret is embedded as a `?secret=` query
  // param on the callback URL at registration time and validated here.
  async verifySignature(request: Request, _body: string, secret: string): Promise<true | Response> {
    const provided = new URL(request.url).searchParams.get('secret') ?? ''
    const expected = secret
    const valid =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected))

    if (!valid) {
      return new Response('Invalid signature', { status: 401 })
    }

    return true
  },

  async parseStatusChange(body: string): Promise<InboundWebhookResult | null> {
    const payload = JSON.parse(body)

    // Jira sends `jira:issue_updated` for issue changes
    if (
      !payload.webhookEvent?.includes('issue_updated') &&
      payload.webhookEvent !== 'jira:issue_updated'
    ) {
      return null
    }

    // Look for a status change in the changelog
    const statusChange = payload.changelog?.items?.find(
      (item: { field: string }) => item.field === 'status'
    )
    if (!statusChange) return null

    const issueKey = payload.issue?.key
    if (!issueKey) return null

    return {
      externalId: issueKey,
      externalStatus: statusChange.toString,
      eventType: 'jira:issue_updated',
    }
  },
}
