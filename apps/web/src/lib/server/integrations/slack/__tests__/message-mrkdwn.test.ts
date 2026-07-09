import { describe, it, expect } from 'vitest'
import { buildSlackMessage, storageKeyFromUrl } from '../message'
import type { ChangelogPublishedEvent } from '../../../events/types'

/**
 * Extract the body text from a built changelog Slack message. The message emits
 * a title section first and then one or more body sections (where
 * markdownToMrkdwn runs), so we join every section after the title.
 */
function changelogBodyText(markdown: string): string {
  const event: ChangelogPublishedEvent = {
    id: 'evt_1',
    type: 'changelog.published',
    timestamp: '2025-06-01T12:00:00Z',
    actor: { type: 'user', displayName: 'Ada' },
    data: {
      changelog: {
        id: 'changelog_1',
        title: 'Release',
        contentPreview: markdown,
        content: markdown,
        publishedAt: '2025-06-01T12:00:00Z',
        linkedPostCount: 0,
      },
    },
  }
  const msg = buildSlackMessage(event, 'https://portal.example.com')
  const sections = (msg.blocks ?? []).filter(
    (b): b is { type: string; text: { text: string } } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'section'
  )
  // Drop the title section (index 0); the rest is the converted body.
  return sections
    .slice(1)
    .map((s) => s.text.text)
    .join('\n')
}

describe('markdownToMrkdwn formatting', () => {
  it('converts `~~strike~~` to Slack single-tilde strikethrough', () => {
    const text = changelogBodyText('Removed ~~old feature~~ today')
    expect(text).toContain('Removed ~old feature~ today')
    expect(text).not.toContain('~~')
  })

  it('strips `++underline++` markers, keeping the inner text', () => {
    const text = changelogBodyText('This is ++important++ news')
    expect(text).toContain('This is important news')
    expect(text).not.toContain('++')
  })

  it('handles strikethrough and underline in the same body', () => {
    const text = changelogBodyText('~~gone~~ and ++here++')
    expect(text).toContain('~gone~ and here')
    expect(text).not.toContain('~~')
    expect(text).not.toContain('++')
  })
})

describe('changelog images', () => {
  function buildImageBlocks(markdown: string): Array<{ image_url: string; alt_text: string }> {
    const event: ChangelogPublishedEvent = {
      id: 'evt_1',
      type: 'changelog.published',
      timestamp: '2025-06-01T12:00:00Z',
      actor: { type: 'user', displayName: 'Ada' },
      data: {
        changelog: {
          id: 'changelog_1',
          title: 'Release',
          contentPreview: markdown,
          content: markdown,
          publishedAt: '2025-06-01T12:00:00Z',
          linkedPostCount: 0,
        },
      },
    }
    const msg = buildSlackMessage(event, 'https://portal.example.com')
    return (msg.blocks ?? []).filter(
      (b): b is { type: string; image_url: string; alt_text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'image'
    )
  }

  it('emits the raw stored image URL (the hook presigns it before sending)', () => {
    const [img] = buildImageBlocks(
      '![shot](https://portal.example.com/api/storage/changelog-images/x.png)'
    )
    expect(img.image_url).toBe('https://portal.example.com/api/storage/changelog-images/x.png')
    expect(img.alt_text).toBe('shot')
  })

  it('emits external/CDN image URLs verbatim', () => {
    const [img] = buildImageBlocks('![cdn](https://cdn.example.com/x.png)')
    expect(img.image_url).toBe('https://cdn.example.com/x.png')
  })

  it('renders the body text without the image markdown', () => {
    const text = changelogBodyText('Before ![shot](https://cdn.example.com/x.png) after')
    expect(text).not.toContain('![')
    expect(text).toContain('Before')
    expect(text).toContain('after')
  })
})

describe('changelog tags', () => {
  function contextTexts(tags?: string[]): string[] {
    const event: ChangelogPublishedEvent = {
      id: 'evt_1',
      type: 'changelog.published',
      timestamp: '2025-06-01T12:00:00Z',
      actor: { type: 'user', displayName: 'Ada' },
      data: {
        changelog: {
          id: 'changelog_1',
          title: 'Release',
          contentPreview: 'body',
          content: 'body',
          ...(tags !== undefined && { tags }),
          publishedAt: '2025-06-01T12:00:00Z',
          linkedPostCount: 0,
        },
      },
    }
    const msg = buildSlackMessage(event, 'https://portal.example.com')
    return (msg.blocks ?? [])
      .filter(
        (b): b is { type: string; elements: Array<{ text: string }> } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'context'
      )
      .flatMap((b) => b.elements.map((e) => e.text))
  }

  it('renders a tag context block when tags are present', () => {
    const texts = contextTexts(['mobile', 'performance'])
    expect(texts.some((t) => t.includes('🏷️ mobile · performance'))).toBe(true)
  })

  it('omits the tag block when there are no tags', () => {
    expect(contextTexts([]).some((t) => t.includes('🏷️'))).toBe(false)
    expect(contextTexts(undefined).some((t) => t.includes('🏷️'))).toBe(false)
  })
})

describe('storageKeyFromUrl', () => {
  it('extracts the key from a storage-route URL', () => {
    expect(
      storageKeyFromUrl('https://portal.example.com/api/storage/changelog-images/2026/07/x.png')
    ).toBe('changelog-images/2026/07/x.png')
  })

  it('strips query and hash from the key', () => {
    expect(
      storageKeyFromUrl('https://portal.example.com/api/storage/logos/x.png?email=1#frag')
    ).toBe('logos/x.png')
  })

  it('returns null for external/CDN URLs', () => {
    expect(storageKeyFromUrl('https://cdn.example.com/x.png')).toBeNull()
  })

  it('rejects path-traversal keys', () => {
    expect(storageKeyFromUrl('https://portal.example.com/api/storage/../secrets')).toBeNull()
  })
})
