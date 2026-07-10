import { SidebarContainer, SidebarSkeleton } from '@/components/shared/sidebar-primitives'
import {
  ChangelogMetadataSidebarContent,
  type ShippedPost,
} from './changelog-metadata-sidebar-content'
import type { PostId, TagId } from '@quackback/ids'
import type { PublishState } from '@/lib/shared/schemas/changelog'

export { SidebarSkeleton as ChangelogMetadataSidebarSkeleton }

interface ChangelogMetadataSidebarProps {
  publishState: PublishState
  onPublishStateChange: (state: PublishState) => void
  linkedPostIds: PostId[]
  onLinkedPostsChange: (postIds: PostId[]) => void
  initialPosts?: ShippedPost[]
  tagIds: TagId[]
  onTagsChange: (tagIds: TagId[]) => void
  authorName?: string | null
  publishedAt?: string | null
  displayDateValue?: Date
  onDisplayDateChange?: (value: Date | undefined) => void
  onDisplayDateClear?: () => void
}

export function ChangelogMetadataSidebar({
  publishState,
  onPublishStateChange,
  linkedPostIds,
  onLinkedPostsChange,
  initialPosts,
  tagIds,
  onTagsChange,
  authorName,
  publishedAt,
  displayDateValue,
  onDisplayDateChange,
  onDisplayDateClear,
}: ChangelogMetadataSidebarProps) {
  return (
    <SidebarContainer className="overflow-y-auto">
      <ChangelogMetadataSidebarContent
        publishState={publishState}
        onPublishStateChange={onPublishStateChange}
        linkedPostIds={linkedPostIds}
        onLinkedPostsChange={onLinkedPostsChange}
        initialPosts={initialPosts}
        tagIds={tagIds}
        onTagsChange={onTagsChange}
        authorName={authorName}
        publishedAt={publishedAt}
        displayDateValue={displayDateValue}
        onDisplayDateChange={onDisplayDateChange}
        onDisplayDateClear={onDisplayDateClear}
      />
    </SidebarContainer>
  )
}
