import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stream E1 partition contract: post-first-regen, the prompt Quill sees must
// describe fragments through the NEW / UPDATED / REMOVED partition headers.
// No flat list, no [USER EDITS] block. This spec is the load-bearing assertion
// behind v0.2.1's prompt rewrite (Phyl PO feedback): if any of those legacy
// shapes leaks back in, this test fails before users notice.

const llmCalls: Array<{ system: string; user: string }> = []
const llmResponse = {
  markdown: '# Fake regenerated markdown',
  infobox: null as unknown,
  citations: [] as unknown[],
}
const fakeCallLlm = vi.fn(async (system: string, user: string) => {
  llmCalls.push({ system, user })
  return llmResponse
})

vi.mock('@robin/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@robin/agent')>()
  return {
    ...original,
    createIngestAgents: vi.fn(() => ({
      wikiClassifier: {},
      fragmenter: {},
      entityExtractor: {},
      fragScorer: {},
      wikiWriter: {},
    })),
    createTypedCaller: vi.fn(() => fakeCallLlm),
    withTypedUsage: vi.fn(() => fakeCallLlm),
    embedText: vi.fn(async () => null),
  }
})

vi.mock('./openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(async () => ({
    apiKey: 'test-key',
    models: {
      extraction: 'test/model',
      classification: 'test/model',
      wikiGeneration: 'test/model',
      embedding: 'test/model',
    },
  })),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

const dbResponseQueue: unknown[][] = []
const dbUpdates: Array<Record<string, unknown>> = []

function stageDbResponses(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}

function popResponse(): unknown[] {
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  function selectChain() {
    return {
      from: () => ({
        where: (..._args: unknown[]) => {
          let deferred: Promise<unknown[]> | null = null
          const ensureDeferred = () => {
            if (!deferred) deferred = Promise.resolve(popResponse())
            return deferred
          }
          return {
            // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
            then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (r: unknown) => unknown) =>
              ensureDeferred().then(onFulfilled, onRejected),
            limit: async () => popResponse(),
            orderBy: () => ({
              limit: async () => popResponse(),
            }),
            groupBy: () => ({
              // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
              then: (onFulfilled: (v: unknown[]) => unknown) =>
                Promise.resolve(popResponse()).then(onFulfilled),
            }),
          }
        },
      }),
    }
  }
  const fakeDb = {
    select: (..._args: unknown[]) => selectChain(),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: (..._args: unknown[]) => {
          dbUpdates.push(data)
          return {
            // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
            then: (onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
              Promise.resolve(undefined).then(onFulfilled, onRejected),
            returning: async () => [{ lookupKey: 'wiki-key-1', state: 'LINKING' }],
          }
        },
      }),
    }),
    insert: () => ({
      values: async () => undefined,
    }),
  }
  return { db: fakeDb }
})

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookupKey',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    description: 'wikis.description',
    slug: 'wikis.slug',
    state: 'wikis.state',
    content: 'wikis.content',
    metadata: 'wikis.metadata',
    citationDeclarations: 'wikis.citationDeclarations',
    embedding: 'wikis.embedding',
    searchVector: 'wikis.searchVector',
    updatedAt: 'wikis.updatedAt',
    deletedAt: 'wikis.deletedAt',
  },
  wikiTypes: {
    slug: 'wikiTypes.slug',
    prompt: 'wikiTypes.prompt',
    userModified: 'wikiTypes.userModified',
  },
  edges: {
    srcId: 'edges.srcId',
    dstId: 'edges.dstId',
    edgeType: 'edges.edgeType',
    attrs: 'edges.attrs',
    deletedAt: 'edges.deletedAt',
  },
  fragments: {
    lookupKey: 'fragments.lookupKey',
    slug: 'fragments.slug',
    title: 'fragments.title',
    content: 'fragments.content',
    embedding: 'fragments.embedding',
    searchVector: 'fragments.searchVector',
    createdAt: 'fragments.createdAt',
    deletedAt: 'fragments.deletedAt',
  },
  edits: {
    objectType: 'edits.objectType',
    objectId: 'edits.objectId',
    source: 'edits.source',
    timestamp: 'edits.timestamp',
    content: 'edits.content',
  },
  people: {
    lookupKey: 'people.lookupKey',
    name: 'people.name',
    content: 'people.content',
    embedding: 'people.embedding',
    searchVector: 'people.searchVector',
    deletedAt: 'people.deletedAt',
  },
}))

const { regenerateWiki } = await import('./regen.js')
const { db: mockDb } = await import('../db/client.js')

function baseWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki-key-1',
    name: 'Mixed-state wiki',
    type: 'log',
    slug: 'mixed-state-wiki',
    content: 'previous body',
    prompt: null,
    deletedAt: null,
    ...overrides,
  }
}

// ── Contract test ─────────────────────────────────────────────────────────
//
// Setup mirrors the existing E1 partition tests in regen.test.ts: a wiki with
// last_rebuilt_at set (post-first-regen) and a partition that exercises both
// NEW and REMOVED fragments. We trigger regen, capture the assembled prompt,
// and assert:
//   1. The partition headers Quill sees match the keystone partition shape
//      (`[NEW FRAGMENTS` and `[REMOVED FRAGMENTS` for this scenario; the
//      UPDATED-only path is covered by the second case below).
//   2. NO `[USER EDITS` block, even when the edits table has rows. The
//      legacy block was Phyl's PO feedback target for v0.2.1 — if any
//      wiki-type YAML reintroduces it the assertion fires here first.
//   3. NO legacy `[FRAGMENTS]` flat-list wrapper bracketing the partitioned
//      content (the v0.2.1 YAML rewrite drops that wrapper since the
//      partition variable carries its own headers).

describe('regenerateWiki — partition contract (Quill never sees flat fragment lists or [USER EDITS] post-first-regen)', () => {
  beforeEach(() => {
    llmCalls.length = 0
    dbUpdates.length = 0
    dbResponseQueue.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the NEW + REMOVED partition with no [USER EDITS] block and no legacy [FRAGMENTS] wrapper', async () => {
    const lastRebuiltAt = new Date('2026-04-01T00:00:00Z')

    const newEdge = {
      srcId: 'frag-new',
      attrs: null,
      createdAt: new Date('2026-04-15T00:00:00Z'),
    }
    const newFrag = {
      lookupKey: 'frag-new',
      slug: 'frag-new',
      title: 'Newly attached fragment',
      content: 'NEW_CONTENT_MARKER body for the new fragment',
      createdAt: new Date('2026-04-15T00:00:00Z'),
      updatedAt: new Date('2026-04-15T00:00:00Z'),
    }
    const removedEdgeRow = { srcId: 'frag-removed' }
    const removedFragRow = {
      lookupKey: 'frag-removed',
      slug: 'frag-removed',
      title: 'Detached fragment',
    }

    // A user-edit row is staged so the [USER EDITS] block would render under
    // the legacy template. After the v0.2.1 rewrite the YAML drops the block
    // and the assertion below (no `[USER EDITS]` substring) holds.
    const userEditRow = { content: 'A note the user typed into the wiki body.' }

    stageDbResponses([
      [baseWiki({ lastRebuiltAt, content: 'previous body' })], // 1. wikis select (outer)
      [],                                  // 2. classifyUnfiledFragments wiki lookup
      [newEdge],                           // 3. active fragment edges
      [removedEdgeRow],                    // 4. REMOVED edge query
      [removedFragRow],                    // 5. REMOVED fragments hydrate
      [newFrag],                           // 6. live fragments hydrate
      [userEditRow],                       // 7. edits query (user-source)
      [],                                  // 8. wikiTypes select (no userModified row)
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.skipped).toBeFalsy()
    expect(llmCalls).toHaveLength(1)

    const userPrompt = llmCalls[0].user

    // Partition headers Quill sees.
    expect(userPrompt).toContain('[NEW FRAGMENTS')
    expect(userPrompt).toContain('[REMOVED FRAGMENTS')

    // The new fragment's content and the removed fragment's slug both surface.
    expect(userPrompt).toContain('NEW_CONTENT_MARKER')
    expect(userPrompt).toContain('frag-removed')

    // The legacy [USER EDITS] block must not surface anywhere in the prompt,
    // even though the edits table returned a row.
    expect(userPrompt).not.toContain('[USER EDITS')
    expect(userPrompt).not.toContain('USER EDITS --')

    // The legacy `[FRAGMENTS]` wrapper header must not double up on top of
    // the partition headers. The v0.2.1 YAML drops the wrapper so the
    // {{fragments}} substitution renders directly.
    expect(userPrompt).not.toMatch(/^\[FRAGMENTS\]$/m)

    // Triggering-fragments partition matches the prompt shape so audit rows
    // and the prompt content stay in lockstep.
    expect(result.triggeringFragments?.new).toHaveLength(1)
    expect(result.triggeringFragments?.removed).toHaveLength(1)
    expect(result.triggeringFragments?.updated).toEqual([])
  })

  it('renders the UPDATED-only partition with no [USER EDITS] block', async () => {
    const lastRebuiltAt = new Date('2026-04-01T00:00:00Z')

    const updatedEdge = {
      srcId: 'frag-updated',
      attrs: null,
      // edge createdAt before last_rebuilt_at → not NEW
      createdAt: new Date('2026-03-01T00:00:00Z'),
    }
    const updatedFrag = {
      lookupKey: 'frag-updated',
      slug: 'frag-updated',
      title: 'Edited fragment',
      content: 'UPDATED_CONTENT_MARKER body for the edited fragment',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      // updated_at after last_rebuilt_at puts this in the UPDATED partition
      updatedAt: new Date('2026-04-20T00:00:00Z'),
    }
    const userEditRow = { content: 'Stale user-edit row that must not surface.' }

    stageDbResponses([
      [baseWiki({ lastRebuiltAt, content: 'previous body' })], // 1. wikis select (outer)
      [],                                  // 2. classifyUnfiledFragments wiki lookup
      [updatedEdge],                       // 3. active fragment edges
      [],                                  // 4. REMOVED edge query (empty)
      [updatedFrag],                       // 5. live fragments hydrate
      [userEditRow],                       // 6. edits query
      [],                                  // 7. wikiTypes select
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.skipped).toBeFalsy()
    expect(llmCalls).toHaveLength(1)

    const userPrompt = llmCalls[0].user

    expect(userPrompt).toContain('[UPDATED FRAGMENTS')
    expect(userPrompt).toContain('UPDATED_CONTENT_MARKER')

    // Legacy [USER EDITS] block must not surface.
    expect(userPrompt).not.toContain('[USER EDITS')
    expect(userPrompt).not.toContain('USER EDITS --')

    // No legacy [FRAGMENTS] wrapper header on its own line.
    expect(userPrompt).not.toMatch(/^\[FRAGMENTS\]$/m)

    expect(result.triggeringFragments?.updated).toHaveLength(1)
    expect(result.triggeringFragments?.new).toEqual([])
    expect(result.triggeringFragments?.removed).toEqual([])
  })
})
