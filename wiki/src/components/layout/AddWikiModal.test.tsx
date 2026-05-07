import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// ── Mocks ────────────────────────────────────────────────────────────────
//
// AddWikiModal pulls the generated SDK and three react-query hooks. The
// publish branch under test is `publishWiki` / `unpublishWiki`; everything
// else (wiki types, collections, bouncer toggle) is incidental and stubbed
// to a stable, harmless shape so the modal can render without a real
// backend.

const publishWikiMock = vi.fn()
const unpublishWikiMock = vi.fn()
const updateWikiMock = vi.fn().mockResolvedValue({ data: {}, error: null })

vi.mock('@/lib/generated', () => ({
  publishWiki: (...args: unknown[]) => publishWikiMock(...args),
  unpublishWiki: (...args: unknown[]) => unpublishWikiMock(...args),
  updateWiki: (...args: unknown[]) => updateWikiMock(...args),
}))

vi.mock('@/hooks/useWikiTypesList', () => ({
  useWikiTypesList: () => ({
    data: {
      wikiTypes: [
        {
          slug: 'log',
          displayLabel: 'Log',
          displayDescription: '',
          displayShortDescriptor: '',
          displayOrder: 1,
          promptYaml: '',
          defaultYaml: '',
          userModified: false,
          basedOnVersion: 1,
          inputVariables: [],
        },
      ],
    },
    isLoading: false,
  }),
  WIKI_TYPES_LIST_KEY: ['wikiTypes', 'v2'],
  findWikiType: () => undefined,
}))

vi.mock('@/hooks/useCollections', () => ({
  useCollections: () => ({ data: [] }),
}))

vi.mock('@/hooks/useToggleBouncerMode', () => ({
  useToggleBouncerMode: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}))

import AddWikiModal from './AddWikiModal'
import type { WikiSettingsPrefill } from './AddWikiModal'

// ── Helpers ──────────────────────────────────────────────────────────────

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
}

const basePrefill: WikiSettingsPrefill = {
  name: 'Engineering Log',
  wikiType: 'log',
  description: 'Daily engineering notes',
  promptOverride: '',
  bouncerMode: 'auto',
  published: false,
  publishedSlug: null,
  collections: [],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── (b) UI half — publish toggle flips backend + UI ──────────────────────

describe('A-game (b) — AddWikiModal publish toggle', () => {
  beforeEach(() => {
    publishWikiMock.mockResolvedValue({
      data: { published: true, publishedSlug: 'minted-slug-aaaaaaaaaaa1' },
      error: null,
    })
    unpublishWikiMock.mockResolvedValue({
      data: { published: false, publishedSlug: null },
      error: null,
    })
  })

  it('publish toggle calls publishWiki with the wiki id and surfaces the URL row', async () => {
    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={basePrefill}
        wikiId="thread01TEST"
      />,
    )

    const toggle = screen.getByRole('switch', { name: /publish wiki/i })
    expect(toggle).toBeInTheDocument()
    // Toggle starts unchecked because prefill.published === false. Base-UI
    // exposes state through aria-checked.
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    // The handler awaits publishWiki — wait for it to fire with the right
    // path. Backend half of the (b) contract.
    await waitFor(() => {
      expect(publishWikiMock).toHaveBeenCalledTimes(1)
    })
    const callArg = publishWikiMock.mock.calls[0]![0] as {
      path: { id: string }
      credentials: string
    }
    expect(callArg.path.id).toBe('thread01TEST')
    expect(callArg.credentials).toBe('include')

    // After the resolve, the URL row should appear. UI half of (b): the
    // optimistic state lands in sync with the server confirm.
    await waitFor(() => {
      expect(screen.getByText('/p/minted-slug-aaaaaaaaaaa1')).toBeInTheDocument()
    })
  })

  it('unpublish toggle calls unpublishWiki and removes the URL row', async () => {
    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={{
          ...basePrefill,
          published: true,
          publishedSlug: 'currentslug00000000000ab',
        }}
        wikiId="thread01TEST"
      />,
    )

    // URL row visible up front because prefill says published=true.
    expect(screen.getByText('/p/currentslug00000000000ab')).toBeInTheDocument()

    const toggle = screen.getByRole('switch', { name: /publish wiki/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(unpublishWikiMock).toHaveBeenCalledTimes(1)
    })

    // URL row should disappear after unpublish.
    await waitFor(() => {
      expect(screen.queryByText('/p/currentslug00000000000ab')).toBeNull()
    })
  })

  it('surfaces the server error message when publishWiki fails', async () => {
    publishWikiMock.mockResolvedValue({
      data: undefined,
      error: { error: 'Cannot publish a wiki with no content' },
    })

    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={basePrefill}
        wikiId="thread01TEST"
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: /publish wiki/i }))

    await waitFor(() => {
      expect(
        screen.getByText('Cannot publish a wiki with no content'),
      ).toBeInTheDocument()
    })
  })
})

// ── (c) Publish-success URL surface — copy + open affordances ────────────

describe('A-game (c) — AddWikiModal copy + open affordances', () => {
  let writeTextMock: ReturnType<typeof vi.fn>
  let openMock: ReturnType<typeof vi.fn>
  let originalClipboard: PropertyDescriptor | undefined
  let originalOpen: ((url?: string | URL, target?: string, features?: string) => Window | null) | undefined

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    // jsdom does not implement navigator.clipboard. Define it for the test
    // run; restore afterwards so we don't leak mutation across files.
    originalClipboard = Object.getOwnPropertyDescriptor(
      window.navigator,
      'clipboard',
    )
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    openMock = vi.fn().mockReturnValue(null)
    originalOpen = window.open
    window.open = openMock as unknown as typeof window.open
  })

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(window.navigator, 'clipboard', originalClipboard)
    } else {
      // If it never existed before our test, drop the property entirely.
      // @ts-expect-error — runtime cleanup
      delete window.navigator.clipboard
    }
    if (originalOpen) {
      window.open = originalOpen
    }
  })

  it('Copy link button writes `${origin}/p/${slug}` to navigator.clipboard', async () => {
    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={{
          ...basePrefill,
          published: true,
          publishedSlug: 'shareable-slug-aaaaaaaab',
        }}
        wikiId="thread01TEST"
      />,
    )

    const copyButton = screen.getByRole('button', { name: /copy link/i })
    fireEvent.click(copyButton)

    expect(writeTextMock).toHaveBeenCalledTimes(1)
    const writtenUrl = writeTextMock.mock.calls[0]![0] as string
    // Origin is whatever jsdom set (typically http://localhost) — assert the
    // shape, not the exact origin, so this stays robust to test-env changes.
    expect(writtenUrl.endsWith('/p/shareable-slug-aaaaaaaab')).toBe(true)
    expect(writtenUrl.startsWith(window.location.origin)).toBe(true)
  })

  it('Open button calls window.open with the same URL and a noopener target', () => {
    // H2 deferred bonus from Wave 3: the publish-success row exposes both
    // Copy AND Open. This locks the Open path so a future refactor can't
    // silently drop it.
    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={{
          ...basePrefill,
          published: true,
          publishedSlug: 'shareable-slug-aaaaaaaab',
        }}
        wikiId="thread01TEST"
      />,
    )

    const openButton = screen.getByRole('button', { name: /^open$/i })
    fireEvent.click(openButton)

    expect(openMock).toHaveBeenCalledTimes(1)
    const [url, target, features] = openMock.mock.calls[0]!
    expect((url as string).endsWith('/p/shareable-slug-aaaaaaaab')).toBe(true)
    expect(target).toBe('_blank')
    expect(features).toBe('noopener,noreferrer')
  })

  it('does NOT render the URL row (or Copy/Open) when published=false', () => {
    renderWithProviders(
      <AddWikiModal
        open={true}
        onClose={() => {}}
        prefill={basePrefill}
        wikiId="thread01TEST"
      />,
    )

    expect(screen.queryByRole('button', { name: /copy link/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^open$/i })).toBeNull()
  })
})
