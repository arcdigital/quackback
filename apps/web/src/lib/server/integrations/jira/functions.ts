/**
 * Jira-specific server functions.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import type { PrincipalId, PostId, IntegrationId } from '@quackback/ids'

export interface JiraOAuthState {
  type: 'jira_oauth'
  workspaceId: string
  returnDomain: string
  principalId: PrincipalId
  nonce: string
  ts: number
}

export interface JiraProject {
  id: string
  name: string
  key: string
}

export interface JiraIssueType {
  id: string
  name: string
  subtask: boolean
}

interface JiraIntegrationConfig {
  cloudId?: string
  siteUrl?: string
  workspaceName?: string
  tokenExpiresAt?: string
  /** Optional Jira accountId to set as the issue reporter. When unset, Jira
   *  defaults the reporter to the OAuth account that authorized the integration. */
  reporterAccountId?: string
}

export const getJiraConnectUrl = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    const { randomBytes } = await import('crypto')
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { signOAuthState } = await import('@/lib/server/auth/oauth-state')
    const { config } = await import('@/lib/server/config')

    const auth = await requireAuth({ roles: ['admin'] })
    const { hasPlatformCredentials } =
      await import('@/lib/server/domains/platform-credentials/platform-credential.service')
    if (!(await hasPlatformCredentials('jira'))) {
      throw new Error(
        'Jira platform credentials not configured. Configure them in integration settings first.'
      )
    }
    const returnDomain = new URL(config.baseUrl).host

    const state = signOAuthState({
      type: 'jira_oauth',
      workspaceId: auth.settings.id,
      returnDomain,
      principalId: auth.principal.id,
      nonce: randomBytes(16).toString('base64url'),
      ts: Date.now(),
    } satisfies JiraOAuthState)

    return `/oauth/jira/connect?state=${encodeURIComponent(state)}`
  }
)

/** Refresh Jira token if expired or about to expire (within 5 minutes). Returns current access token. */
async function getJiraAccessToken(integration: { secrets: unknown; config: unknown }) {
  const { decryptSecrets, encryptSecrets } = await import('../encryption')
  const { db, integrations, eq } = await import('@/lib/server/db')
  const { logger } = await import('@/lib/server/logger')
  const log = logger.child({ component: 'jira' })

  const secrets = decryptSecrets<{ accessToken: string; refreshToken?: string }>(
    integration.secrets as string
  )
  const cfg = (integration.config ?? {}) as JiraIntegrationConfig

  if (secrets.refreshToken && cfg.tokenExpiresAt) {
    const expiresAt = new Date(cfg.tokenExpiresAt).getTime()
    const bufferMs = 5 * 60 * 1000
    if (Date.now() >= expiresAt - bufferMs) {
      log.info('access token expired, refreshing')
      const { refreshJiraToken } = await import('./oauth')
      const { getPlatformCredentials } =
        await import('@/lib/server/domains/platform-credentials/platform-credential.service')
      const credentials = await getPlatformCredentials('jira')
      const refreshed = await refreshJiraToken(secrets.refreshToken, credentials ?? undefined)

      const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      await db
        .update(integrations)
        .set({
          secrets: encryptSecrets({
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          }),
          config: { ...cfg, tokenExpiresAt: newExpiry },
          updatedAt: new Date(),
        })
        .where(eq(integrations.integrationType, 'jira'))

      return refreshed.accessToken
    }
  }

  return secrets.accessToken
}

export const fetchJiraProjectsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<JiraProject[]> => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, eq } = await import('@/lib/server/db')
    const { listJiraProjects } = await import('./projects')

    await requireAuth({ roles: ['admin'] })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'jira'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Jira not connected')
    }

    const cloudId = (integration.config as JiraIntegrationConfig)?.cloudId
    if (!cloudId) {
      throw new Error('Jira cloud ID not found in integration config')
    }

    const accessToken = await getJiraAccessToken(integration)
    return listJiraProjects(accessToken, cloudId)
  }
)

const fetchIssueTypesSchema = z.object({
  projectId: z.string().min(1),
})

export const fetchJiraIssueTypesFn = createServerFn({ method: 'POST' })
  .validator(fetchIssueTypesSchema)
  .handler(async ({ data }): Promise<JiraIssueType[]> => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, eq } = await import('@/lib/server/db')
    const { listJiraIssueTypes } = await import('./projects')

    await requireAuth({ roles: ['admin'] })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'jira'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Jira not connected')
    }

    const cloudId = (integration.config as JiraIntegrationConfig)?.cloudId
    if (!cloudId) {
      throw new Error('Jira cloud ID not found in integration config')
    }

    const accessToken = await getJiraAccessToken(integration)
    return listJiraIssueTypes(accessToken, cloudId, data.projectId)
  })

/**
 * Extract a Jira issue key (e.g. "QUA-24") from raw user input, which may be a
 * bare key or a browse URL like https://acme.atlassian.net/browse/QUA-24.
 * Returns the uppercased key, or null if no valid key is present.
 */
function parseJiraIssueKey(input: string): string | null {
  const trimmed = input.trim()
  // Prefer the last /browse/<KEY> segment when a URL is pasted, else the raw value.
  const fromUrl = trimmed.match(/\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/)
  const candidate = fromUrl?.[1] ?? trimmed
  const match = candidate.match(/^([A-Za-z][A-Za-z0-9_]+-\d+)$/)
  return match ? match[1].toUpperCase() : null
}

const linkJiraIssueSchema = z.object({
  postId: z.string().min(1),
  /** A Jira issue key ("QUA-24") or a browse URL containing one. */
  issueRef: z.string().min(1),
})

/**
 * Manually link an existing Jira issue to a post. Validates the issue exists
 * via the Jira API, then stores a post_external_links row keyed by issue key so
 * inbound status sync (which matches on the issue key) keeps working.
 */
export const linkJiraIssueFn = createServerFn({ method: 'POST' })
  .validator(linkJiraIssueSchema)
  .handler(async ({ data }) => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, postExternalLinks, eq } = await import('@/lib/server/db')
    const { getJiraIssue } = await import('./projects')
    const { logger } = await import('@/lib/server/logger')
    const log = logger.child({ component: 'jira' })

    await requireAuth({ roles: ['admin', 'member'] })

    const issueKey = parseJiraIssueKey(data.issueRef)
    if (!issueKey) {
      throw new Error('Enter a valid Jira issue key (e.g. QUA-24) or issue URL')
    }

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'jira'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Jira not connected')
    }

    const cfg = (integration.config as JiraIntegrationConfig) ?? {}
    const cloudId = cfg.cloudId
    if (!cloudId) {
      throw new Error('Jira cloud ID not found in integration config')
    }

    const accessToken = await getJiraAccessToken(integration)
    const issue = await getJiraIssue(accessToken, cloudId, issueKey)
    if (!issue) {
      throw new Error(`Jira issue ${issueKey} not found`)
    }

    const externalUrl = cfg.siteUrl
      ? `${cfg.siteUrl.replace(/\/$/, '')}/browse/${issue.key}`
      : `https://api.atlassian.com/ex/jira/${cloudId}/browse/${issue.key}`

    // externalId is the issue key so inbound webhooks (keyed on the key) resolve
    // back to this post. Idempotent on (type, externalId, postId).
    await db
      .insert(postExternalLinks)
      .values({
        postId: data.postId as PostId,
        integrationId: integration.id as IntegrationId,
        integrationType: 'jira',
        externalId: issue.key,
        externalDisplayId: issue.key,
        externalUrl,
      })
      .onConflictDoNothing()

    log.info({ post_id: data.postId, issue_key: issue.key }, 'linked jira issue to post')

    return { issueKey: issue.key, summary: issue.summary, externalUrl }
  })

const createJiraIssueSchema = z.object({
  postId: z.string().min(1),
})

/**
 * Manually create a Jira issue from a post and link it. Uses the project +
 * issue type configured on the Jira integration (config.channelId =
 * "projectId:issueTypeId"). This is the on-demand equivalent of the outbound
 * post.created hook, exposed as a per-post admin action.
 */
export const createJiraIssueFn = createServerFn({ method: 'POST' })
  .validator(createJiraIssueSchema)
  .handler(async ({ data }) => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, postExternalLinks, eq } = await import('@/lib/server/db')
    const { getPostWithDetails } = await import('@/lib/server/domains/posts/post.query')
    const { buildJiraIssueBodyFromPost } = await import('./message')
    const { getBaseUrl } = await import('@/lib/server/config')
    const { logger } = await import('@/lib/server/logger')
    const log = logger.child({ component: 'jira' })

    await requireAuth({ roles: ['admin', 'member'] })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'jira'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Jira not connected')
    }

    const cfg = (integration.config as JiraIntegrationConfig & { channelId?: string }) ?? {}
    const cloudId = cfg.cloudId
    if (!cloudId) {
      throw new Error('Jira cloud ID not found in integration config')
    }

    // channelId is stored as "projectId:issueTypeId" by the Jira config UI.
    const [projectId, issueTypeId] = (cfg.channelId ?? '').split(':')
    if (!projectId) {
      throw new Error('No Jira project configured. Set one in Jira integration settings.')
    }

    const post = await getPostWithDetails(data.postId as PostId)
    const settings = await db.query.settings.findFirst({ columns: { name: true } })
    const { title, description } = buildJiraIssueBodyFromPost(
      {
        id: post.id,
        title: post.title,
        content: post.content ?? '',
        boardSlug: post.board.slug,
        authorName: post.authorName,
        authorEmail: post.authorEmail,
      },
      getBaseUrl(),
      settings?.name || undefined
    )

    const accessToken = await getJiraAccessToken(integration)
    const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { id: projectId },
          summary: title,
          description,
          ...(issueTypeId ? { issuetype: { id: issueTypeId } } : {}),
          ...(cfg.reporterAccountId ? { reporter: { id: cfg.reporterAccountId } } : {}),
        },
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      log.error({ status: response.status, body }, 'jira issue creation failed')
      throw new Error(`Jira issue creation failed (HTTP ${response.status})`)
    }

    const result = (await response.json()) as { key?: string }
    if (!result.key) {
      throw new Error('No issue key returned from Jira')
    }

    const externalUrl = cfg.siteUrl
      ? `${cfg.siteUrl.replace(/\/$/, '')}/browse/${result.key}`
      : `https://api.atlassian.com/ex/jira/${cloudId}/browse/${result.key}`

    await db
      .insert(postExternalLinks)
      .values({
        postId: data.postId as PostId,
        integrationId: integration.id as IntegrationId,
        integrationType: 'jira',
        externalId: result.key,
        externalDisplayId: result.key,
        externalUrl,
      })
      .onConflictDoNothing()

    log.info({ post_id: data.postId, issue_key: result.key }, 'created jira issue from post')

    return { issueKey: result.key, externalUrl }
  })
