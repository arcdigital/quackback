'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { LinkIcon, ArrowTopRightOnSquareIcon, XMarkIcon } from '@heroicons/react/24/solid'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { adminQueries } from '@/lib/client/queries/admin'
import { usePostExternalLinks } from '@/lib/client/hooks/use-post-external-links-query'
import { JiraIcon } from '@/components/icons/integration-icons'
import { useLinkJiraIssue, useCreateJiraIssue, useUnlinkExternalLink } from '@/lib/client/mutations'
import type { PostId } from '@quackback/ids'

interface LinkedIssuesCardProps {
  postId: PostId
}

/**
 * Admin post panel for viewing linked external issues and manually linking a
 * Jira issue by key or URL. Only shows the Jira link input when Jira is
 * connected; existing links from any integration are always listed.
 */
export function LinkedIssuesCard({ postId }: LinkedIssuesCardProps) {
  const [issueRef, setIssueRef] = useState('')

  // Always fetch links here (the cascade-delete dialog also uses this query).
  const linksQuery = usePostExternalLinks(postId, true)
  const { data: jira } = useQuery(adminQueries.integrationByType('jira'))
  const jiraConnected = jira?.integration?.status === 'active'
  // channelId is "projectId:issueTypeId"; a create needs at least a project.
  const jiraProjectConfigured = Boolean(
    (jira?.integration?.config?.channelId as string | undefined)?.split(':')[0]
  )

  const linkJira = useLinkJiraIssue(postId)
  const createJira = useCreateJiraIssue(postId)
  const unlink = useUnlinkExternalLink(postId)

  const links = linksQuery.data ?? []

  // Don't render at all when there's nothing to show and no way to add.
  if (!jiraConnected && links.length === 0) return null

  const handleLink = async () => {
    const value = issueRef.trim()
    if (!value) return
    try {
      const result = await linkJira.mutateAsync(value)
      toast.success(`Linked ${result.issueKey}`)
      setIssueRef('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link issue')
    }
  }

  const handleCreate = async () => {
    try {
      const result = await createJira.mutateAsync()
      toast.success(`Created ${result.issueKey}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create issue')
    }
  }

  const handleUnlink = async (linkId: string, label: string) => {
    try {
      await unlink.mutateAsync(linkId)
      toast.success(`Unlinked ${label}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unlink')
    }
  }

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <LinkIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Linked issues</span>
      </div>

      {links.length > 0 && (
        <ul className="space-y-1.5">
          {links.map((link) => {
            const label = link.externalDisplayId ?? link.externalId
            return (
              <li
                key={link.id}
                className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs uppercase text-muted-foreground shrink-0">
                    {link.integrationType}
                  </span>
                  {link.externalUrl ? (
                    <a
                      href={link.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium truncate hover:underline inline-flex items-center gap-1"
                    >
                      {label}
                      <ArrowTopRightOnSquareIcon className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-sm font-medium truncate">{label}</span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => handleUnlink(link.id, label)}
                  disabled={unlink.isPending}
                  aria-label={`Unlink ${label}`}
                >
                  <XMarkIcon className="h-3.5 w-3.5" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {jiraConnected && (
        <div className="space-y-2">
          {jiraProjectConfigured && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={handleCreate}
              disabled={createJira.isPending}
            >
              <JiraIcon className="h-4 w-4" />
              {createJira.isPending ? 'Creating...' : 'Create Jira issue'}
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={issueRef}
              onChange={(e) => setIssueRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleLink()
                }
              }}
              placeholder="Jira issue key or URL (e.g. QUA-24)"
              disabled={linkJira.isPending}
              className="h-8 text-sm"
            />
            <Button
              type="button"
              size="sm"
              onClick={handleLink}
              disabled={linkJira.isPending || !issueRef.trim()}
            >
              {linkJira.isPending ? 'Linking...' : 'Link'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
