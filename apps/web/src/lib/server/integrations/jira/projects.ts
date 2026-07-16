/**
 * Jira project and issue type listing via REST API.
 */

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira'

/**
 * List Jira projects accessible to the authenticated user.
 */
export async function listJiraProjects(
  accessToken: string,
  cloudId: string
): Promise<Array<{ id: string; name: string; key: string }>> {
  const response = await fetch(`${JIRA_API_BASE}/${cloudId}/rest/api/3/project/search`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to list Jira projects: HTTP ${response.status}`)
  }

  const data = (await response.json()) as {
    values?: Array<{ id: string; name: string; key: string }>
  }

  return (data.values ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    key: project.key,
  }))
}

/**
 * Fetch a single Jira issue by key (e.g. "QUA-24") to validate it exists and
 * get its summary. Returns null when the issue is not found (HTTP 404).
 */
export async function getJiraIssue(
  accessToken: string,
  cloudId: string,
  issueKey: string
): Promise<{ id: string; key: string; summary: string } | null> {
  const params = new URLSearchParams({ fields: 'summary' })
  const response = await fetch(
    `${JIRA_API_BASE}/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  )

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Failed to fetch Jira issue: HTTP ${response.status}`)
  }

  const data = (await response.json()) as {
    id: string
    key: string
    fields?: { summary?: string }
  }

  return { id: data.id, key: data.key, summary: data.fields?.summary ?? data.key }
}

/**
 * List Jira issue types for a given project.
 */
export async function listJiraIssueTypes(
  accessToken: string,
  cloudId: string,
  projectId: string
): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
  const params = new URLSearchParams({ projectId })
  const response = await fetch(
    `${JIRA_API_BASE}/${cloudId}/rest/api/3/issuetype/project?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to list Jira issue types: HTTP ${response.status}`)
  }

  const data = (await response.json()) as Array<{
    id: string
    name: string
    subtask: boolean
  }>

  return data.map((issueType) => ({
    id: issueType.id,
    name: issueType.name,
    subtask: issueType.subtask,
  }))
}
