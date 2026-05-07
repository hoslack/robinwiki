import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks ────────────────────────────────────────────────────────────────
//
// /published is the anonymous read surface — no session middleware, just
// a slug → row lookup gated on `published = true AND deletedAt IS NULL`.
// We mock db.select to return whatever the test scenario dictates and
// stub the sidecar builder so we don't drag in YAML loaders or fragment
// joins for what is a trivial filter test.

const mockDbSelect = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}))

vi.mock('../lib/wikiSidecar.js', () => ({
  // Return an empty sidecar so the schema parses. Sidecar correctness
  // is a separate concern (covered in m-wiki-sidecar tests) — here we
  // only assert the public-access matrix (published vs unpublished vs
  // unknown) does the right thing at the route boundary.
  buildSidecar: vi.fn().mockResolvedValue({
    refs: {},
    infobox: null,
    sections: [],
  }),
}))

vi.mock('../lib/wikiSidecarDeps.js', () => ({
  makeSidecarDeps: vi.fn().mockReturnValue({}),
}))

vi.mock('../lib/strip-wiki-content.js', () => ({
  stripWikiContent: vi.fn().mockImplementation((content: string) => content),
}))

import { publishedRoutes } from '../routes/published.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/published', publishedRoutes)
  return app
}

function selectChainMock(rows: unknown[]) {
  // /published only ever uses .from().where().limit(1) — no fancy joins.
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  return chain
}

const publishedAt = new Date('2026-04-01T12:00:00Z')

function makePublishedRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Engineering Log',
    type: 'log',
    publishedAt,
    content: '# Engineering Log\n\nBody text.',
    published: true,
    metadata: null,
    citationDeclarations: [],
    ...overrides,
  }
}

// ── Tests — A-game (d) anon access matrix ────────────────────────────────

describe('A-game (d) — GET /published/wiki/:nanoid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 with public body when wiki is published', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([makePublishedRow()]))

    const app = createApp()
    const res = await app.request('/published/wiki/fixedslug0000000000000ab')
    expect(res.status).toBe(200)

    const json = (await res.json()) as {
      name: string
      type: string
      publishedAt: string
      content: string
      refs: Record<string, unknown>
      infobox: unknown
      sections: unknown[]
    }
    expect(json.name).toBe('Engineering Log')
    expect(json.type).toBe('log')
    expect(json.content).toContain('Engineering Log')
    expect(json.refs).toEqual({})
    expect(json.infobox).toBeNull()
    expect(Array.isArray(json.sections)).toBe(true)
  })

  it('returns 404 when slug exists but the wiki has been unpublished', async () => {
    // The route's WHERE clause is `publishedSlug = :nanoid AND published = true
    // AND deletedAt IS NULL`. An unpublished row simply does not match — the
    // mock returns [] to model the row being filtered out by the predicate.
    // This is the issue-#253 contract: revoke means revoke, not "still
    // serves the cached body".
    mockDbSelect.mockReturnValue(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/published/wiki/fixedslug0000000000000ab')
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Not found')
  })

  it('returns 404 when nanoid is unknown (no row at all)', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/published/wiki/never-existed-nanoid-xx')
    expect(res.status).toBe(404)
  })

  it('returns 404 when row matches predicate but content is null', async () => {
    // Defensive branch — content shouldn't be null on a published row, but
    // the route guards against it explicitly. Without this branch the
    // sidecar builder would crash on a null body. Lock the 404 contract.
    mockDbSelect.mockReturnValue(
      selectChainMock([makePublishedRow({ content: null })]),
    )

    const app = createApp()
    const res = await app.request('/published/wiki/fixedslug0000000000000ab')
    expect(res.status).toBe(404)
  })

  it('sets Cache-Control: no-store on the published response', async () => {
    // Public reads must not be cached by intermediate proxies — once a
    // user unpublishes, even a 5-minute CDN cache is too long. Locks the
    // policy in place.
    mockDbSelect.mockReturnValue(selectChainMock([makePublishedRow()]))
    const app = createApp()
    const res = await app.request('/published/wiki/fixedslug0000000000000ab')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('returns raw text body when ?raw query param is present', async () => {
    // The raw branch is the markdown-source escape hatch for tooling.
    // Returns text/plain (not JSON) and skips the schema parse. Proves
    // the branch wires through `stripWikiContent`.
    mockDbSelect.mockReturnValue(selectChainMock([makePublishedRow()]))

    const app = createApp()
    const res = await app.request('/published/wiki/fixedslug0000000000000ab?raw')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Engineering Log')
  })
})
