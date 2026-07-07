/**
 * Changelog tag filtering.
 *
 * Tags (the global pool shared with posts) can be attached to changelog entries
 * and used to scope both the admin list and the public list — e.g. one tag per
 * product. These tests pin the two contracts that are easy to regress:
 *   1. A tag filter adds the `changelogHasAnyTag` predicate to the query.
 *   2. With no tag filter, that predicate is absent (no accidental scoping).
 *
 * The predicate is `inArray(changelogEntries.id, <tag subselect>)` — NOT raw
 * ``sql`… IN (…)` ``. That distinction is load-bearing: a raw IN interpolation
 * both mis-binds the array as one param AND bypasses the TypeId→uuid conversion
 * the query builder applies, which broke the feature at runtime. The subselect
 * marker below asserts we went through the builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId, TagId } from '@quackback/ids'

// Records every WHERE condition set passed to the entries query so we can
// assert whether the tag EXISTS predicate was included.
let capturedConditions: unknown[] = []

function entriesListChain(rows: unknown[]): unknown {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = (cond: unknown) => {
    capturedConditions.push(cond)
    return chain
  }
  chain.orderBy = () => chain
  chain.limit = () => Promise.resolve(rows)
  chain.leftJoin = () => chain
  chain.innerJoin = () => chain
  chain.then = (resolve: (v: unknown[]) => unknown) => resolve(rows)
  return chain
}

const mockSelect = vi.fn((_args?: unknown) => entriesListChain([]))
const mockEntryFindMany = vi.fn().mockResolvedValue([])

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      changelogEntries: { findMany: (...a: unknown[]) => mockEntryFindMany(...a) },
      principal: { findMany: vi.fn().mockResolvedValue([]) },
      changelogEntryPosts: { findMany: vi.fn().mockResolvedValue([]) },
      postStatuses: { findMany: vi.fn().mockResolvedValue([]) },
    },
    select: (...a: unknown[]) => mockSelect(a),
    // changelogHasAnyTag builds `selectDistinct({id}).from(tags).where(inArray(tagId, ids))`
    // as the subselect handed to the outer inArray. The chain just needs to be
    // an identity so the returned object is what the outer inArray receives.
    selectDistinct: () => {
      const chain: Record<string, unknown> = {}
      chain.from = () => chain
      chain.where = () => chain
      return chain
    },
  },
  changelogEntries: { id: 'id', publishedAt: 'published_at', deletedAt: 'deleted_at' },
  changelogEntryPosts: { changelogEntryId: 'changelog_entry_id', postId: 'post_id' },
  changelogEntryTags: { changelogEntryId: 'changelog_entry_id', tagId: 'tag_id' },
  posts: { id: 'posts.id' },
  boards: { id: 'boards.id', slug: 'boards.slug', access: 'boards.access', deletedAt: 'b.deleted' },
  principal: { id: 'principal.id' },
  postStatuses: { id: 'id' },
  tags: { id: 'tags.id', name: 'tags.name', color: 'tags.color', deletedAt: 'tags.deleted_at' },
  eq: vi.fn((col, val) => ({ kind: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ kind: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ kind: 'or', args })),
  asc: vi.fn((col) => ({ kind: 'asc', col })),
  isNull: vi.fn((col) => ({ kind: 'isNull', col })),
  isNotNull: vi.fn((col) => ({ kind: 'isNotNull', col })),
  lt: vi.fn((col, val) => ({ kind: 'lt', col, val })),
  lte: vi.fn((col, val) => ({ kind: 'lte', col, val })),
  gt: vi.fn((col, val) => ({ kind: 'gt', col, val })),
  desc: vi.fn((col) => ({ kind: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ kind: 'inArray', col, vals })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      kind: 'sql',
      strings: Array.from(strings),
      values,
    })),
    { raw: vi.fn() }
  ),
}))

// Recursively determine whether a captured condition tree contains the tag
// filter: an `inArray` on changelogEntries.id (the outer predicate from
// changelogHasAnyTag). The mocked inArray records `{kind:'inArray', col, vals}`.
function mentionsTagFilter(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as Record<string, unknown>
  if (n.kind === 'inArray' && n.col === 'id') return true
  if (n.kind === 'and' && Array.isArray(n.args)) {
    return n.args.some(mentionsTagFilter)
  }
  return false
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedConditions = []
  mockSelect.mockImplementation(() => entriesListChain([]))
  mockEntryFindMany.mockResolvedValue([])
})

describe('changelogHasAnyTag', () => {
  it('builds an inArray predicate on the entry id (via the query builder, not raw SQL)', async () => {
    const { changelogHasAnyTag } = await import('../changelog.tags')
    const pred = changelogHasAnyTag(['tag_1', 'tag_2'] as TagId[]) as unknown as {
      kind: string
      col: string
    }
    // Must be an inArray on the entries id column — a raw `sql` node here would
    // be the regression (mis-bound array param + no TypeId→uuid conversion).
    expect(pred.kind).toBe('inArray')
    expect(pred.col).toBe('id')
  })
})

describe('listPublicChangelogs — tag filter', () => {
  it('adds the tag predicate when tagIds are provided', async () => {
    const { listPublicChangelogs } = await import('../changelog.public')
    await listPublicChangelogs({ tagIds: ['tag_1'] as TagId[] })
    expect(capturedConditions.some(mentionsTagFilter)).toBe(true)
  })

  it('does not add a tag predicate when no tagIds are provided', async () => {
    const { listPublicChangelogs } = await import('../changelog.public')
    await listPublicChangelogs({})
    expect(capturedConditions.some(mentionsTagFilter)).toBe(false)
  })

  it('does not add a tag predicate for an empty tagIds array', async () => {
    const { listPublicChangelogs } = await import('../changelog.public')
    await listPublicChangelogs({ tagIds: [] as TagId[] })
    expect(capturedConditions.some(mentionsTagFilter)).toBe(false)
  })
})

describe('listChangelogs (admin) — tag filter', () => {
  it('adds the tag predicate when tagIds are provided', async () => {
    // Admin list reads entries via db.query.changelogEntries.findMany, whose
    // `where` we capture through the call args.
    mockEntryFindMany.mockImplementation((args: { where?: unknown }) => {
      capturedConditions.push(args?.where)
      return Promise.resolve([])
    })
    const { listChangelogs } = await import('../changelog.query')
    await listChangelogs({ tagIds: ['tag_1'] as TagId[], limit: 10 })
    // The captured `where` is a single `and(...)` wrapping all conditions.
    const called = mockEntryFindMany.mock.calls.length > 0
    expect(called).toBe(true)
    expect(capturedConditions.some(mentionsTagFilter)).toBe(true)
  })

  it('omits the tag predicate with no tag filter', async () => {
    mockEntryFindMany.mockImplementation((args: { where?: unknown }) => {
      capturedConditions.push(args?.where)
      return Promise.resolve([])
    })
    const { listChangelogs } = await import('../changelog.query')
    await listChangelogs({ limit: 10 })
    expect(capturedConditions.some(mentionsTagFilter)).toBe(false)
  })
})

describe('changelog id assertion helper', () => {
  // Guards against a silly typo in the fixtures above: ChangelogId import used.
  it('accepts a changelog id type', () => {
    const id = 'changelog_x' as ChangelogId
    expect(typeof id).toBe('string')
  })
})
