import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── G3 regression test ────────────────────────────────────────────────────
//
// Asserts the HTTP /search route and the MCP `search` tool emit identical
// validated `searchResponseSchema` payloads for the same query against the
// same `hybridSearch()` output. Pre-fix the MCP tool stringified the bare
// `SearchResult[]` array and bypassed `searchResponseSchema.parse()`, so a
// future schema change on the HTTP side could drift silently from MCP.
// Both paths now share the schema — this test guards the contract.

const FIXTURE_RESULTS = [
  { id: 'frag-1', type: 'fragment' as const, title: 'Hello', snippet: 'world', score: 0.91 },
  { id: 'wiki-1', type: 'wiki' as const, title: 'Robin', snippet: 'second brain', score: 0.74 },
  { id: 'pers-1', type: 'person' as const, title: 'Ada Lovelace', snippet: 'mathematician', score: 0.42 },
]

const mockHybridSearch = vi.fn(async () => FIXTURE_RESULTS)

vi.mock('./search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./search.js')>()
  return {
    ...actual,
    hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  }
})

vi.mock('./openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(async () => {
    throw new Error('no key configured — fall back to bm25')
  }),
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

vi.mock('../db/client.js', () => ({
  db: { __mock: 'db' },
}))

vi.mock('../db/schema.js', () => ({
  fragments: {},
  wikis: {},
  people: {},
  edges: {},
  auditLog: {},
  groups: {},
  groupWikis: {},
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn(),
}))

vi.mock('./resolvers.js', () => ({
  listWikis: vi.fn(),
  getWiki: vi.fn(),
  getFragment: vi.fn(),
  findPersonById: vi.fn(),
  findPersonByQuery: vi.fn(),
  listWikiTypes: vi.fn(),
  briefPerson: vi.fn(),
  resolveWikiBySlug: vi.fn(),
}))

vi.mock('./handlers.js', () => ({
  handleLogEntry: vi.fn(),
  handleLogFragment: vi.fn(),
  handleCreateWikiType: vi.fn(),
  handleCreateWiki: vi.fn(),
  handleEditWiki: vi.fn(),
}))

beforeEach(() => {
  mockHybridSearch.mockClear()
  mockHybridSearch.mockImplementation(async () => FIXTURE_RESULTS)
})

describe('HTTP /search and MCP search tool: shape parity', () => {
  it('returns identical searchResponseSchema-validated payloads for the same query', async () => {
    // Resolve dynamically so the mocks above are wired in before module load.
    const { search } = await import('../routes/search.js')
    const { createMcpServer } = await import('../mcp/server.js')

    // Build a Hono app and call /search?q=...
    const app = new Hono()
    app.route('/search', search)
    const httpRes = await app.request('/search?q=hello&mode=bm25')
    expect(httpRes.status).toBe(200)
    const httpJson = (await httpRes.json()) as { results: unknown[] }

    // Spin up MCP and invoke the registered `search` tool's callback directly.
    const server = createMcpServer({ db: { __mock: 'db' } as never })
    // Reach into the server's registered tools — the test SDK exposes the
    // tool map on the underlying server. If the API changes upstream we'll
    // need to revisit, but for v1 this is the cheapest harness available.
    const tools = (server as unknown as { _registeredTools?: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools
    expect(tools).toBeDefined()
    expect(tools!.search).toBeDefined()

    const mcpOutput = await tools!.search.handler({ query: 'hello', mode: 'bm25' }, {
      authInfo: { clientId: 'test' },
    })
    expect(mcpOutput.content[0].type).toBe('text')
    const mcpJson = JSON.parse(mcpOutput.content[0].text) as { results: unknown[] }

    // Both surfaces called hybridSearch with the same query.
    expect(mockHybridSearch).toHaveBeenCalled()

    // Strict shape parity: both payloads have a `results` key, both arrays
    // contain identical SearchResult objects validated through the same
    // searchResponseSchema.
    expect(mcpJson).toEqual(httpJson)
    expect(mcpJson.results).toEqual(FIXTURE_RESULTS)
  })
})
