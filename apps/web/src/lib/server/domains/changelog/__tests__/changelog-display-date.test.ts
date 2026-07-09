import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'

const mockEntryFindFirst = vi.fn()
const mockUpdateSet = vi.fn()
const mockUpdateWhere = vi.fn()
const mockChangelogEntryPostsFindMany = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      changelogEntries: {
        findFirst: (...args: unknown[]) => mockEntryFindFirst(...args),
      },
      changelogEntryPosts: {
        findMany: (...args: unknown[]) => mockChangelogEntryPostsFindMany(...args),
      },
      principal: { findFirst: vi.fn().mockResolvedValue(null) },
      postStatuses: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    update: () => ({
      set: (values: unknown) => {
        mockUpdateSet(values)
        return { where: (...args: unknown[]) => mockUpdateWhere(...args) }
      },
    }),
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    // getChangelogById → getChangelogTagsForEntries issues a tag select; a
    // thenable chain resolving to [] covers it regardless of builder shape.
    select: () => anySelectChain(),
  },
  changelogEntries: { id: 'id', publishedAt: 'published_at', deletedAt: 'deleted_at' },
  changelogEntryPosts: { changelogEntryId: 'changelog_entry_id', postId: 'post_id' },
  changelogEntryTags: { changelogEntryId: 'changelog_entry_id', tagId: 'tag_id' },
  posts: { id: 'posts.id' },
  principal: { id: 'principal.id' },
  postStatuses: { id: 'postStatuses.id' },
  tags: { id: 'tags.id', name: 'tags.name', color: 'tags.color', deletedAt: 'tags.deleted_at' },
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}))

// Thenable select-chain: every builder method returns the chain, and awaiting
// resolves to `rows`. Covers `.where()`-terminal and `.where().orderBy()` alike.
function anySelectChain(rows: unknown[] = []): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[m] = () => chain
  }
  chain.then = (resolve: (v: unknown[]) => unknown) => resolve(rows)
  return chain
}

vi.mock('@/lib/server/content/rehost-images', () => ({
  rehostExternalImages: vi.fn(async (json: unknown) => json),
}))
vi.mock('@/lib/server/events/dispatch', () => ({
  buildEventActor: vi.fn(() => ({ type: 'user' })),
  dispatchChangelogPublished: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
  cancelScheduledDispatch: vi.fn().mockResolvedValue(undefined),
}))

const ENTRY_ID = 'changelog_01test' as ChangelogId
const PUBLISHED_AT = new Date('2025-06-01T12:00:00Z')

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    title: 'Release',
    content: 'Body',
    contentJson: null,
    principalId: null,
    publishedAt: PUBLISHED_AT,
    displayDate: null,
    createdAt: new Date('2025-06-01T10:00:00Z'),
    updatedAt: new Date('2025-06-01T10:00:00Z'),
    deletedAt: null,
    viewCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChangelogEntryPostsFindMany.mockResolvedValue([])
})

describe('displayDate', () => {
  it('persists displayDate without changing publishedAt', async () => {
    const { updateChangelog } = await import('../changelog.service')
    const pastDisplay = new Date('2024-01-15T09:00:00Z')

    mockEntryFindFirst
      .mockResolvedValueOnce(baseEntry())
      .mockResolvedValueOnce(baseEntry({ displayDate: pastDisplay }))

    await updateChangelog(ENTRY_ID, { displayDate: pastDisplay })

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ displayDate: pastDisplay })
    )
    const updatePayload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>
    expect(updatePayload).not.toHaveProperty('publishedAt')
  })

  it('rejects displayDate in the future', async () => {
    const { updateChangelog } = await import('../changelog.service')
    mockEntryFindFirst.mockResolvedValueOnce(baseEntry())

    await expect(
      updateChangelog(ENTRY_ID, { displayDate: new Date(Date.now() + 60_000) })
    ).rejects.toBeInstanceOf(ValidationError)
    expect(mockUpdateSet).not.toHaveBeenCalled()
  })

  it('accepts displayDate when publishing a draft in the same request', async () => {
    const { updateChangelog } = await import('../changelog.service')
    const pastDisplay = new Date('2024-01-15T09:00:00Z')

    // Existing entry is a draft (publishedAt: null). Publishing it while also
    // setting a display date must validate against the incoming publishState's
    // publishedAt, not the stale draft value.
    mockEntryFindFirst
      .mockResolvedValueOnce(baseEntry({ publishedAt: null }))
      .mockResolvedValueOnce(baseEntry({ displayDate: pastDisplay }))

    await updateChangelog(ENTRY_ID, {
      displayDate: pastDisplay,
      publishState: { type: 'published', publishAt: PUBLISHED_AT },
    })

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ displayDate: pastDisplay, publishedAt: PUBLISHED_AT })
    )
  })

  it('stores null when displayDate matches publishedAt calendar day', async () => {
    const { updateChangelog } = await import('../changelog.service')
    const sameDay = new Date('2025-06-01T18:00:00Z')

    mockEntryFindFirst.mockResolvedValueOnce(baseEntry()).mockResolvedValueOnce(baseEntry())

    await updateChangelog(ENTRY_ID, { displayDate: sameDay })

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ displayDate: null }))
  })
})
