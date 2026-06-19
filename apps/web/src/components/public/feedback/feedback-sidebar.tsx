import { ListBulletIcon, ChatBubbleLeftIcon } from '@heroicons/react/24/solid'
import { FormattedMessage } from 'react-intl'
import { cn } from '@/lib/shared/utils'
import type { PublicBoardWithStats } from '@/lib/shared/types'

interface FeedbackSidebarProps {
  boards: PublicBoardWithStats[]
  currentBoard?: string
  onBoardChange: (board: string | undefined) => void
  workspaceSlug?: string
}

export function FeedbackSidebar({
  boards,
  currentBoard,
  onBoardChange,
}: FeedbackSidebarProps) {
  return (
    <aside className="w-64 shrink-0 hidden lg:block">
      <div className="sticky top-24">
        <div className="bg-card border border-border/50 rounded-lg shadow-sm overflow-hidden">
          <h2 className="font-semibold text-xs uppercase tracking-wider text-muted-foreground px-4 pt-4 pb-3">
            <FormattedMessage id="portal.feedback.sidebar.boards" defaultMessage="Boards" />
          </h2>
          <nav className="space-y-1 px-4 pb-4 max-h-[calc(100vh-16rem)] overflow-y-auto scrollbar-thin">
            {/* View all posts */}
            <button
              type="button"
              onClick={() => onBoardChange(undefined)}
              className={cn(
                'max-w-full flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors cursor-pointer w-full text-left',
                !currentBoard
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <ListBulletIcon className={cn('h-4 w-4 shrink-0', !currentBoard && 'text-primary')} />
              <span className="truncate">
                <FormattedMessage
                  id="portal.feedback.sidebar.viewAllPosts"
                  defaultMessage="View all posts"
                />
              </span>
            </button>

            {/* Board list */}
            {boards.map((board) => {
              const isActive = currentBoard === board.slug
              return (
                <button
                  key={board.id}
                  type="button"
                  onClick={() => onBoardChange(board.slug)}
                  className={cn(
                    'max-w-full flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors cursor-pointer w-full text-left',
                    isActive
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                >
                  <ChatBubbleLeftIcon
                    className={cn('h-4 w-4 shrink-0', isActive && 'text-primary')}
                  />
                  <span className="truncate min-w-0">{board.name}</span>
                  {board.postCount > 0 && (
                    <span
                      className={cn(
                        'text-[10px] font-semibold ms-auto ps-1 shrink-0 tabular-nums',
                        isActive ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      {board.postCount}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

      </div>
    </aside>
  )
}
