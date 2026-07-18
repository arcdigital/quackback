/**
 * Jira hook handler.
 * Creates Jira issues when feedback events occur.
 */

import type { HookHandler, HookResult } from '../../events/hook-types'
import type { EventData } from '../../events/types'
import { isRetryableError } from '../../events/hook-utils'
import { resolveExternalStatuses, type StatusMappings } from '../status-mapping'
import { buildJiraIssueBody } from './message'
import { getJiraAccessToken } from './token'
import { and, db, eq, integrations, postExternalLinks } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import type { PostId } from '@quackback/ids'

const log = logger.child({ component: 'jira' })

export interface JiraTarget {
  channelId: string // projectId is stored as channelId for consistency
}

export interface JiraConfig {
  accessToken: string
  cloudId: string
  siteUrl?: string
  issueTypeId?: string
  rootUrl: string
  workspaceName?: string
  /** Optional Jira accountId to set as the issue reporter. */
  reporterAccountId?: string
  statusMappings?: StatusMappings
}

async function jiraApi(
  method: string,
  url: string,
  accessToken: string,
  body?: unknown
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  if (!response.ok) {
    const status = response.status
    if (status === 401) throw Object.assign(new Error('Unauthorized'), { status })
    if (status === 429) throw Object.assign(new Error('Rate limited'), { status })
    if (status >= 500) throw Object.assign(new Error(`Server error ${status}`), { status })
    throw Object.assign(new Error(`HTTP ${status}`), { status })
  }

  return response
}

interface JiraIssueStatus {
  fields?: {
    status?: {
      name?: string
    }
  }
}

interface JiraTransitions {
  transitions?: Array<{
    id: string
    to?: {
      name?: string
    }
  }>
}

function statusMatches(left: string | undefined, right: string): boolean {
  return left?.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

async function transitionLinkedIssues(
  event: Extract<EventData, { type: 'post.status_changed' }>,
  accessToken: string,
  cloudId: string,
  statusMappings: StatusMappings | undefined
): Promise<HookResult> {
  if (!event.data.newStatusId) {
    log.warn({ post_id: event.data.post.id }, 'status sync skipped: event has no status id')
    return { success: true }
  }

  const externalStatuses = resolveExternalStatuses(event.data.newStatusId, statusMappings)
  if (externalStatuses.length === 0) {
    log.warn(
      {
        post_id: event.data.post.id,
        status_id: event.data.newStatusId,
        status_name: event.data.newStatus,
      },
      'status sync skipped: no Jira status mapping'
    )
    return { success: true }
  }

  const links = await db.query.postExternalLinks.findMany({
    where: and(
      eq(postExternalLinks.postId, event.data.post.id as PostId),
      eq(postExternalLinks.integrationType, 'jira'),
      eq(postExternalLinks.status, 'active')
    ),
  })

  if (links.length === 0) {
    log.warn({ post_id: event.data.post.id }, 'status sync skipped: no linked Jira issues')
    return { success: true }
  }

  log.info(
    {
      post_id: event.data.post.id,
      linked_issue_count: links.length,
      external_statuses: externalStatuses,
    },
    'syncing linked Jira issue statuses'
  )

  const baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`

  for (const link of links) {
    const issueKey = encodeURIComponent(link.externalId)
    const issueResponse = await jiraApi(
      'GET',
      `${baseUrl}/issue/${issueKey}?fields=status`,
      accessToken
    )
    const issue = (await issueResponse.json()) as JiraIssueStatus
    const currentStatus = issue.fields?.status?.name

    if (externalStatuses.some((status) => statusMatches(currentStatus, status))) {
      continue
    }

    const transitionsResponse = await jiraApi(
      'GET',
      `${baseUrl}/issue/${issueKey}/transitions`,
      accessToken
    )
    const { transitions = [] } = (await transitionsResponse.json()) as JiraTransitions
    const transition = transitions.find((candidate) =>
      externalStatuses.some((status) => statusMatches(candidate.to?.name, status))
    )

    if (!transition) {
      return {
        success: false,
        error: `No Jira transition from "${currentStatus ?? 'unknown'}" to mapped status "${externalStatuses.join('" or "')}" for ${link.externalId}`,
        shouldRetry: false,
      }
    }

    await jiraApi('POST', `${baseUrl}/issue/${issueKey}/transitions`, accessToken, {
      transition: { id: transition.id },
    })
    log.info(
      { issue_key: link.externalId, external_status: transition.to?.name },
      'linked issue status updated'
    )
  }

  return { success: true }
}

async function resolveRuntimeConfig(
  fallbackToken: string,
  fallbackCloudId: string,
  fallbackStatusMappings: StatusMappings | undefined
): Promise<{
  accessToken: string
  cloudId: string
  statusMappings: StatusMappings | undefined
}> {
  const integration = await db.query.integrations.findFirst({
    where: eq(integrations.integrationType, 'jira'),
    columns: { secrets: true, config: true },
  })

  if (!integration?.secrets) {
    return {
      accessToken: fallbackToken,
      cloudId: fallbackCloudId,
      statusMappings: fallbackStatusMappings,
    }
  }

  const latestConfig = (integration.config ?? {}) as {
    cloudId?: string
    statusMappings?: StatusMappings
  }

  return {
    accessToken: await getJiraAccessToken(integration),
    cloudId: latestConfig.cloudId ?? fallbackCloudId,
    statusMappings: latestConfig.statusMappings ?? fallbackStatusMappings,
  }
}

export const jiraHook: HookHandler = {
  async run(event: EventData, target: unknown, config: unknown): Promise<HookResult> {
    const { channelId: projectId } = target as JiraTarget
    const {
      accessToken,
      cloudId,
      siteUrl,
      issueTypeId,
      rootUrl,
      workspaceName,
      reporterAccountId,
      statusMappings,
    } = config as JiraConfig

    if (event.type === 'post.status_changed') {
      try {
        const runtime = await resolveRuntimeConfig(accessToken, cloudId, statusMappings)
        return await transitionLinkedIssues(
          event,
          runtime.accessToken,
          runtime.cloudId,
          runtime.statusMappings
        )
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        const status = (error as { status?: number }).status

        if (status === 401) {
          return {
            success: false,
            error: 'Authentication failed. Please reconnect Jira.',
            shouldRetry: false,
          }
        }

        return {
          success: false,
          error: errorMsg,
          shouldRetry: isRetryableError(error),
        }
      }
    }

    if (event.type !== 'post.created') {
      return { success: true }
    }

    log.debug({ event_type: event.type, project_id: projectId }, 'creating issue')

    const { title, description } = buildJiraIssueBody(event, rootUrl, workspaceName)

    const issueBody: Record<string, unknown> = {
      fields: {
        project: { id: projectId },
        summary: title,
        description,
        ...(issueTypeId ? { issuetype: { id: issueTypeId } } : {}),
        ...(reporterAccountId ? { reporter: { id: reporterAccountId } } : {}),
      },
    }

    try {
      const runtime = await resolveRuntimeConfig(accessToken, cloudId, statusMappings)
      const apiUrl = `https://api.atlassian.com/ex/jira/${runtime.cloudId}/rest/api/3/issue`
      const response = await jiraApi('POST', apiUrl, runtime.accessToken, issueBody)
      const result = (await response.json()) as { id?: string; key?: string; self?: string }

      if (!result.key) {
        return { success: false, error: 'No issue key returned', shouldRetry: false }
      }

      const issueUrl = siteUrl
        ? `${siteUrl}/browse/${result.key}`
        : `https://api.atlassian.com/ex/jira/${cloudId}/browse/${result.key}`
      log.info({ issue_key: result.key }, 'issue created')
      return { success: true, externalId: result.key, externalUrl: issueUrl }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      const status = (error as { status?: number }).status

      if (status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please reconnect Jira.',
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
}
