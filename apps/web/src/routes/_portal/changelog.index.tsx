import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { useIntl } from 'react-intl'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { RssIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shared/page-header'
import { ChangelogListPublic } from '@/components/portal/changelog'
import { portalQueries } from '@/lib/client/queries/portal'
import { cn } from '@/lib/shared/utils'

const searchSchema = z.object({
  tags: z.array(z.string()).optional(),
})

export const Route = createFileRoute('/_portal/changelog/')({
  validateSearch: searchSchema,
  loader: async ({ context }) => {
    return {
      workspaceName: context.settings?.name ?? 'Quackback',
      baseUrl: context.baseUrl ?? '',
    }
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const { workspaceName, baseUrl } = loaderData
    const title = `Changelog - ${workspaceName}`
    const description = `Stay up to date with the latest ${workspaceName} product updates and shipped features.`
    const canonicalUrl = baseUrl ? `${baseUrl}/changelog` : ''
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        ...(canonicalUrl ? [{ property: 'og:url', content: canonicalUrl }] : []),
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
      ],
      links: canonicalUrl ? [{ rel: 'canonical', href: canonicalUrl }] : [],
    }
  },
  component: ChangelogPage,
})

function ChangelogPage() {
  const intl = useIntl()
  const navigate = useNavigate({ from: Route.fullPath })
  const { tags: selectedTagIds = [] } = Route.useSearch()

  // Available tags for the filter. Only tags actually attached to a public
  // entry are worth showing, but the full public tag list is cheap and matches
  // the board-filter UX; the query itself is what scopes the entries.
  const { data: allTags = [] } = useQuery(portalQueries.tags())

  const toggleTag = (tagId: string) => {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter((id) => id !== tagId)
      : [...selectedTagIds, tagId]
    void navigate({
      search: (prev) => ({ ...prev, tags: next.length > 0 ? next : undefined }),
      replace: true,
    })
  }

  return (
    <div className="mx-auto max-w-6xl w-full px-4 sm:px-6 py-8">
      <PageHeader
        size="large"
        title={intl.formatMessage({ id: 'portal.changelog.title', defaultMessage: 'Changelog' })}
        description={intl.formatMessage({
          id: 'portal.changelog.description',
          defaultMessage: 'Stay up to date with the latest product updates and shipped features.',
        })}
        action={
          <Button variant="outline" size="sm" asChild className="shrink-0 gap-1.5">
            <a href="/changelog/feed" target="_blank" rel="noopener noreferrer">
              <RssIcon className="h-4 w-4" />
              <span className="hidden sm:inline">
                {intl.formatMessage({ id: 'portal.changelog.rssFeed', defaultMessage: 'RSS Feed' })}
              </span>
            </a>
          </Button>
        }
        animate
        className="mb-8"
      />

      {/* Tag filter — toggles URL ?tags= state and scopes the list query */}
      {allTags.length > 0 && (
        <div className="mb-8 flex flex-wrap gap-2">
          {allTags.map((tag) => {
            const isSelected = selectedTagIds.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggleTag(tag.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'
                )}
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden="true"
                />
                {tag.name}
              </button>
            )
          })}
        </div>
      )}

      <div
        className="animate-in fade-in duration-300 fill-mode-backwards"
        style={{ animationDelay: '100ms' }}
      >
        <ChangelogListPublic tagIds={selectedTagIds.length > 0 ? selectedTagIds : undefined} />
      </div>
    </div>
  )
}
