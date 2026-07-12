import { describe, it, expect } from 'vitest'
import { buildSlackMessage, storageKeyFromUrl } from '../message'
import type { ChangelogPublishedEvent } from '../../../events/types'

/**
 * Extract the body text from a built changelog Slack message. The title is now a
 * `header` block, so every `section` block is body content (where
 * markdownToMrkdwn runs).
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
  return sections.map((s) => s.text.text).join('\n')
}

describe('changelog message structure', () => {
  function build() {
    const event: ChangelogPublishedEvent = {
      id: 'evt_1',
      type: 'changelog.published',
      timestamp: '2025-06-01T12:00:00Z',
      actor: { type: 'user', displayName: 'Ada' },
      data: {
        changelog: {
          id: 'changelog_1',
          title: 'Big Release',
          contentPreview: 'body',
          content: 'body',
          publishedAt: '2025-06-01T12:00:00Z',
          linkedPostCount: 0,
        },
      },
    }
    return (buildSlackMessage(event, 'https://portal.example.com').blocks ?? []) as Array<{
      type: string
      text?: { type: string; text: string }
      elements?: Array<{ text: string }>
    }>
  }

  it('leads with a divider then a header so posts are visually separated', () => {
    const blocks = build()
    expect(blocks[0].type).toBe('divider')
    expect(blocks[1].type).toBe('header')
    expect(blocks[1].text?.type).toBe('plain_text')
    expect(blocks[1].text?.text).toContain('Big Release')
  })

  it('puts the clickable link and author in the context row', () => {
    const blocks = build()
    const context = blocks.find((b) => b.type === 'context')
    expect(context?.elements?.[0].text).toContain(
      'https://portal.example.com/changelog/changelog_1'
    )
    expect(context?.elements?.[0].text).toContain('Ada')
  })
})

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

  it('renders every heading level as a single bold line', () => {
    const text = changelogBodyText('# H1\n\n## H2\n\n### H3\n\n#### H4')
    expect(text).toContain('*H1*')
    expect(text).toContain('*H2*')
    expect(text).toContain('*H3*')
    expect(text).toContain('*H4*')
    expect(text).not.toContain('#')
  })

  it('flattens bold nested inside a heading (no broken nested markers)', () => {
    // `## Heading **x**` must not become `*Heading *x* *` — Slack has no nested
    // bold and would render it broken.
    const text = changelogBodyText('## Heading with **bold** inside')
    expect(text).toContain('*Heading with bold inside*')
    expect(text).not.toContain('**')
    expect(text).not.toContain('*Heading with *')
  })

  it('keeps links and italic inside a heading', () => {
    const text = changelogBodyText('### See [docs](https://x.co) and *note*')
    expect(text).toContain('*See <https://x.co|docs> and _note_*')
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
