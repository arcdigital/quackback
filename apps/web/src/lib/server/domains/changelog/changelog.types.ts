/**
 * Input/Output types for Changelog Service operations
 */

import type { TiptapContent } from '@/lib/server/db'
import type { ChangelogId, PrincipalId, PostId, TagId } from '@quackback/ids'
import type { PublishState } from '@/lib/shared/schemas/changelog'

export type { PublishState } from '@/lib/shared/schemas/changelog'

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for creating a new changelog entry
 */
export interface CreateChangelogInput {
  title: string
  content: string
  contentJson?: TiptapContent | null
  /** IDs of posts to link to this changelog entry */
  linkedPostIds?: PostId[]
  /** IDs of tags to attach to this changelog entry */
  tagIds?: TagId[]
  /** Publish state */
  publishState: PublishState
  displayDate?: Date | null
}

/**
 * Input for updating an existing changelog entry
 */
export interface UpdateChangelogInput {
  title?: string
  content?: string
  contentJson?: TiptapContent | null
  /** IDs of posts to link (replaces existing links) */
  linkedPostIds?: PostId[]
  /** IDs of tags to attach (replaces existing tags) */
  tagIds?: TagId[]
  /** Publish state (if changing) */
  publishState?: PublishState
  displayDate?: Date | null
}

/**
 * Parameters for listing changelog entries
 */
export interface ListChangelogParams {
  /** Filter by status */
  status?: 'draft' | 'scheduled' | 'published' | 'all'
  /** Filter to entries carrying at least one of these tags */
  tagIds?: TagId[]
  /** Cursor-based pagination */
  cursor?: string
  /** Number of items to return */
  limit?: number
}

// ============================================================================
// Output Types
// ============================================================================

/**
 * Changelog entry with author and linked posts (admin view)
 */
export interface ChangelogEntryWithDetails {
  id: ChangelogId
  title: string
  content: string
  contentJson: TiptapContent | null
  principalId: PrincipalId | null
  publishedAt: Date | null
  displayDate: Date | null
  createdAt: Date
  updatedAt: Date
  /** Author information - only shown in admin views */
  author: ChangelogAuthor | null
  /** Linked posts */
  linkedPosts: ChangelogLinkedPost[]
  /** Attached tags */
  tags: ChangelogTag[]
  /** Computed status based on publishedAt */
  status: 'draft' | 'scheduled' | 'published'
}

/**
 * Changelog author information
 */
export interface ChangelogAuthor {
  id: PrincipalId
  name: string
  avatarUrl: string | null
}

/**
 * Tag attached to a changelog entry (shared with the global tag pool).
 */
export interface ChangelogTag {
  id: TagId
  name: string
  color: string
}

/**
 * Linked post summary for changelog
 */
export interface ChangelogLinkedPost {
  id: PostId
  title: string
  voteCount: number
  status: {
    name: string
    color: string
  } | null
  /** Board slug, author, and creation time — used by the admin edit modal to
   *  render linked-post cards for posts not present in the current search. */
  boardSlug: string
  authorName: string | null
  createdAt: string
}

/**
 * Paginated changelog list result
 */
export interface ChangelogListResult {
  items: ChangelogEntryWithDetails[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * Public changelog entry for portal view (no author info)
 */
export interface PublicChangelogEntry {
  id: ChangelogId
  title: string
  content: string
  contentJson: TiptapContent | null
  publishedAt: Date
  linkedPosts: PublicChangelogLinkedPost[]
  /** Attached tags (surfaced publicly for filtering/display) */
  tags: ChangelogTag[]
}

/**
 * Public linked post for changelog portal
 */
export interface PublicChangelogLinkedPost {
  id: PostId
  title: string
  voteCount: number
  boardSlug: string
  status: {
    name: string
    color: string
  } | null
}

/**
 * Public changelog list result
 */
export interface PublicChangelogListResult {
  items: PublicChangelogEntry[]
  nextCursor: string | null
  hasMore: boolean
}
