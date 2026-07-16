/**
 * Mutations for manually linking/unlinking external issues (e.g. Jira) to a post.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PostId } from '@quackback/ids'
import { linkJiraIssueFn } from '@/lib/server/integrations/jira/functions'
import { unlinkPostExternalLinkFn } from '@/lib/server/functions/posts'
import { externalLinksKeys } from '@/lib/client/hooks/use-post-external-links-query'

export function useLinkJiraIssue(postId: PostId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (issueRef: string) => linkJiraIssueFn({ data: { postId, issueRef } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: externalLinksKeys.byPost(postId) })
    },
  })
}

export function useUnlinkExternalLink(postId: PostId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (linkId: string) => unlinkPostExternalLinkFn({ data: { postId, linkId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: externalLinksKeys.byPost(postId) })
    },
  })
}
