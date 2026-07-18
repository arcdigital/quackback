import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostStatusChangedEvent } from '../../../events/types'

const findMany = vi.fn()
const findIntegration = vi.fn()
const getJiraAccessToken = vi.fn()

vi.mock('@/lib/server/db', () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  db: {
    query: {
      integrations: { findFirst: findIntegration },
      postExternalLinks: { findMany },
    },
  },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  postExternalLinks: {
    postId: 'post_id',
    integrationType: 'integration_type',
    status: 'status',
  },
  integrations: {
    integrationType: 'integration_type',
  },
}))

vi.mock('../token', () => ({
  getJiraAccessToken,
}))

const { jiraHook } = await import('../hook')

const target = { channelId: 'project-1' }
const config = {
  accessToken: 'jira-token',
  cloudId: 'cloud-1',
  rootUrl: 'https://feedback.example.com',
  statusMappings: {
    'To Do': 'status_open',
    'In Progress': 'status_progress',
    Done: 'status_closed',
  },
}

function statusChangedEvent(newStatusId = 'status_closed'): PostStatusChangedEvent {
  return {
    id: 'event-1',
    type: 'post.status_changed',
    timestamp: '2026-01-01T00:00:00.000Z',
    actor: { type: 'user', principalId: 'principal-1' },
    data: {
      post: {
        id: 'post-1',
        title: 'Broken export',
        boardId: 'board-1',
        boardSlug: 'bugs',
      },
      previousStatus: 'In Progress',
      newStatus: 'Closed',
      newStatusId,
    },
  }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  findMany.mockReset()
  findMany.mockResolvedValue([{ externalId: 'APP-42' }])
  findIntegration.mockReset()
  findIntegration.mockResolvedValue({ secrets: 'encrypted', config: {} })
  getJiraAccessToken.mockReset()
  getJiraAccessToken.mockResolvedValue('fresh-jira-token')
})

describe('jiraHook outbound status sync', () => {
  it('transitions every linked Jira issue to the mapped status', async () => {
    findMany.mockResolvedValue([{ externalId: 'APP-42' }, { externalId: 'OPS-7' }])
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('?fields=status')) {
        return jsonResponse({ fields: { status: { name: 'In Progress' } } })
      }
      if (init.method === 'GET') {
        return jsonResponse({
          transitions: [
            { id: '31', to: { name: 'Done' } },
            { id: '41', to: { name: 'Canceled' } },
          ],
        })
      }
      return jsonResponse({}, 204)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await jiraHook.run(statusChangedEvent(), target, config)

    expect(result).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(getJiraAccessToken).toHaveBeenCalledTimes(1)
    const transitionCalls = fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')
    expect(transitionCalls).toHaveLength(2)
    expect(JSON.parse(transitionCalls[0][1].body as string)).toEqual({
      transition: { id: '31' },
    })
    expect(transitionCalls[0][1].headers).toMatchObject({
      Authorization: 'Bearer fresh-jira-token',
    })
  })

  it('does not transition an issue already at a mapped target status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ fields: { status: { name: 'Done' } } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await jiraHook.run(statusChangedEvent(), target, config)

    expect(result).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the Quackback status has no outbound mapping', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await jiraHook.run(statusChangedEvent('status_unmapped'), target, config)

    expect(result).toEqual({ success: true })
    expect(findMany).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a permanent failure when the Jira workflow has no mapped transition', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('?fields=status')) {
        return jsonResponse({ fields: { status: { name: 'To Do' } } })
      }
      return jsonResponse({ transitions: [{ id: '21', to: { name: 'In Progress' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await jiraHook.run(statusChangedEvent(), target, config)

    expect(result).toEqual({
      success: false,
      error: 'No Jira transition from "To Do" to mapped status "Done" for APP-42',
      shouldRetry: false,
    })
  })
})
