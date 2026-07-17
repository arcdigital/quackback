/**
 * Jira webhook registration.
 *
 * Uses Jira REST API to create/delete webhooks for issue status sync.
 * Note: Jira Cloud webhooks expire after 30 days by default.
 */

interface JiraWebhookResult {
  webhookId: string
}

/**
 * Build the JQL filter scoping which issues trigger the webhook.
 * When project keys are provided, the webhook only fires for those projects;
 * otherwise it fires for all projects.
 */
function buildWebhookJql(projectKeys?: string[]): string {
  const keys = (projectKeys ?? []).map((k) => k.trim()).filter(Boolean)
  if (keys.length === 0) return 'project is not EMPTY'
  // Project keys are alphanumeric identifiers; quote each defensively for JQL.
  const quoted = keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(', ')
  return `project in (${quoted})`
}

/**
 * Register a webhook with Jira to receive issue update events.
 *
 * When `projectKeys` is provided and non-empty, the webhook is scoped to those
 * projects; otherwise it fires for all projects.
 */
export async function registerJiraWebhook(
  accessToken: string,
  cloudId: string,
  callbackUrl: string,
  secret: string,
  projectKeys?: string[]
): Promise<JiraWebhookResult> {
  // Jira Cloud's REST-registered ("dynamic") webhooks do NOT support HMAC
  // signing — the X-Hub-Signature/`secret` field only applies to legacy admin
  // (1.0) webhooks. So we authenticate deliveries by embedding the secret as a
  // query param on the callback URL and validating it in the inbound handler.
  const signedUrl = new URL(callbackUrl)
  signedUrl.searchParams.set('secret', secret)

  const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: signedUrl.toString(),
      webhooks: [
        {
          jqlFilter: buildWebhookJql(projectKeys),
          events: ['jira:issue_updated'],
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Jira API error ${response.status}: ${body}`)
  }

  const result = (await response.json()) as {
    webhookRegistrationResult?: Array<{ createdWebhookId?: number }>
  }
  const webhookId = result.webhookRegistrationResult?.[0]?.createdWebhookId
  if (!webhookId) {
    throw new Error('No webhook ID returned from Jira')
  }

  return { webhookId: String(webhookId) }
}

/**
 * Delete a webhook from Jira.
 */
export async function deleteJiraWebhook(
  accessToken: string,
  cloudId: string,
  webhookId: string
): Promise<void> {
  await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhookIds: [Number(webhookId)] }),
  })
}
