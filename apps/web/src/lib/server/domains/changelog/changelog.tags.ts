/**
 * Changelog ↔ tag helpers.
 *
 * Changelog entries reuse the global `tags` pool (the same tags used on posts),
 * so a "product" tag can scope both feedback and changelog. This module owns the
 * link/fetch/filter primitives shared by the service, admin query, and public
 * read paths.
 */

import {
  db,
  changelogEntries,
  changelogEntryTags,
  tags,
  eq,
  and,
  asc,
  isNull,
  inArray,
} from '@/lib/server/db'
import type { ChangelogId, TagId } from '@quackback/ids'
import type { SQL } from 'drizzle-orm'
import type { ChangelogTag } from './changelog.types'

/**
 * Attach tags to a changelog entry. Silently skips ids that don't resolve to a
 * live tag (mirrors linkPostsToChangelog's validate-then-insert approach).
 */
export async function linkTagsToChangelog(
  changelogId: ChangelogId,
  tagIds: TagId[]
): Promise<void> {
  const existingTags = await db.query.tags.findMany({
    where: and(inArray(tags.id, tagIds), isNull(tags.deletedAt)),
    columns: { id: true },
  })

  const existingTagIds = new Set(existingTags.map((t) => t.id))
  const validTagIds = tagIds.filter((id) => existingTagIds.has(id))

  if (validTagIds.length > 0) {
    await db.insert(changelogEntryTags).values(
      validTagIds.map((tagId) => ({
        changelogEntryId: changelogId,
        tagId,
      }))
    )
  }
}

/** Replace all tags on a changelog entry with the given set (delete + relink). */
export async function replaceChangelogTags(
  changelogId: ChangelogId,
  tagIds: TagId[]
): Promise<void> {
  await db.delete(changelogEntryTags).where(eq(changelogEntryTags.changelogEntryId, changelogId))
  if (tagIds.length > 0) {
    await linkTagsToChangelog(changelogId, tagIds)
  }
}

/**
 * Batch-fetch tags for many changelog entries in one query, grouped by entry id
 * and ordered by name. Excludes soft-deleted tags. Shared by the admin and
 * public list paths to avoid an N+1 per entry.
 */
export async function getChangelogTagsForEntries(
  entryIds: ChangelogId[]
): Promise<Map<ChangelogId, ChangelogTag[]>> {
  const grouped = new Map<ChangelogId, ChangelogTag[]>()
  if (entryIds.length === 0) return grouped

  const rows = await db
    .select({
      changelogEntryId: changelogEntryTags.changelogEntryId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(changelogEntryTags)
    .innerJoin(tags, eq(changelogEntryTags.tagId, tags.id))
    .where(and(inArray(changelogEntryTags.changelogEntryId, entryIds), isNull(tags.deletedAt)))
    .orderBy(asc(tags.name))

  for (const row of rows) {
    const list = grouped.get(row.changelogEntryId) ?? []
    list.push({ id: row.id, name: row.name, color: row.color })
    grouped.set(row.changelogEntryId, list)
  }
  return grouped
}

/** Fetch the tags attached to a single changelog entry, ordered by name. */
export async function getChangelogTags(id: ChangelogId): Promise<ChangelogTag[]> {
  const map = await getChangelogTagsForEntries([id])
  return map.get(id) ?? []
}

/**
 * SQL predicate: the entry has at least one of the given tags.
 *
 * Built with drizzle's `inArray` + a subselect (the same shape roadmap.query
 * uses to filter posts by tag) rather than raw ``sql`… IN (…)` ``. That matters:
 * `tag_id`/`changelog_entry_id` are branded TypeId columns backed by `uuid`, and
 * only the query builder applies the TypeId→uuid conversion. Interpolating the
 * prefixed ids (`tag_01…`) into raw SQL bypasses it and Postgres rejects them as
 * malformed uuids.
 */
export function changelogHasAnyTag(tagIds: TagId[]): SQL<unknown> {
  return inArray(
    changelogEntries.id,
    db
      .selectDistinct({ id: changelogEntryTags.changelogEntryId })
      .from(changelogEntryTags)
      .where(inArray(changelogEntryTags.tagId, tagIds))
  )
}
