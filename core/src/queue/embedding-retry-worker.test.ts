import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { fragments as realFragments } from '../db/schema.js'

// ── Module-level mocks ─────────────────────────────────────────────────────

const embedTextMock = vi.fn()
const takeLastEmbedFailureMock = vi.fn()
vi.mock('@robin/agent', () => ({
  embedText: (...args: unknown[]) => embedTextMock(...args),
  takeLastEmbedFailure: () => takeLastEmbedFailureMock(),
}))

const loadOpenRouterConfigMock = vi.fn()
vi.mock('../lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: () => loadOpenRouterConfigMock(),
}))

// Captured DB calls so tests can assert on them. The drizzle chain stubs
// below push into these in order.
const selectReturns: Array<Array<Record<string, unknown>>> = []
const updateCapture: Array<{ set: Record<string, unknown> }> = []
const whereCapture: Array<unknown> = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          whereCapture.push(clause)
          return {
            orderBy: () => ({
              limit: () =>
                Promise.resolve(selectReturns.shift() ?? []),
            }),
          }
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateCapture.push({ set: v })
        return { where: () => Promise.resolve() }
      },
    }),
  },
}))

// Note: we intentionally do NOT mock '../db/schema.js'. Using the real
// fragments table is required for issue #216's regression test, which feeds
// the captured where expression into PgDialect to validate that the Date
// cutoff binds without throwing TypeError [ERR_INVALID_ARG_TYPE].

const { processEmbeddingRetryJob } = await import('./embedding-retry-worker.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function baseJob() {
  return {
    type: 'embedding-retry' as const,
    jobId: 'job-1',
    triggeredBy: 'scheduler' as const,
    enqueuedAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  embedTextMock.mockReset()
  takeLastEmbedFailureMock.mockReset()
  loadOpenRouterConfigMock.mockReset()
  selectReturns.length = 0
  updateCapture.length = 0
  whereCapture.length = 0
  loadOpenRouterConfigMock.mockResolvedValue({
    apiKey: 'k',
    models: { extraction: 'x', classification: 'y', wikiGeneration: 'z', embedding: 'e' },
  })
})

// ── Cases ──────────────────────────────────────────────────────────────────

describe('processEmbeddingRetryJob — issue #151', () => {
  it('persists the embedding when embedText succeeds', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'hello', attemptCount: 0 },
    ])
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(updateCapture).toHaveLength(1)
    expect(updateCapture[0].set.embedding).toEqual([0.1, 0.2, 0.3])
    expect(updateCapture[0].set.embeddingLastAttemptAt).toBeInstanceOf(Date)
  })

  it('bumps attempt_count without persisting when embedText returns null', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'hello', attemptCount: 2 },
    ])
    embedTextMock.mockResolvedValueOnce(null)
    takeLastEmbedFailureMock.mockReturnValueOnce({
      kind: 'http',
      status: 429,
      body: 'rate limited',
    })
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(updateCapture).toHaveLength(1)
    expect(updateCapture[0].set.embeddingAttemptCount).toBe(3)
    expect(updateCapture[0].set.embedding).toBeUndefined()
    expect(updateCapture[0].set.embeddingLastAttemptAt).toBeInstanceOf(Date)
  })

  it('no-ops when OpenRouter config is unavailable', async () => {
    loadOpenRouterConfigMock.mockRejectedValueOnce(new Error('no key'))
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(embedTextMock).not.toHaveBeenCalled()
    expect(updateCapture).toHaveLength(0)
  })

  // Regression test for issue #216: prior to the fix, the worker passed a
  // raw Date into a `sql\`...\`` template literal, which made the pg driver
  // throw `TypeError [ERR_INVALID_ARG_TYPE]` at every 15-min cron tick. The
  // fix uses Drizzle's typed `lt()` comparison, which normalizes Date into
  // an ISO string param the driver accepts.
  it('issue #216: serializes Date cutoff in where clause without throwing', async () => {
    selectReturns.push([])
    await processEmbeddingRetryJob(baseJob())
    expect(whereCapture).toHaveLength(1)
    // Sanity check: the captured where targets the real schema column so
    // PgDialect can resolve column references during compilation.
    expect(realFragments.embeddingLastAttemptAt).toBeDefined()
    const dialect = new PgDialect()
    expect(() => dialect.sqlToQuery(whereCapture[0] as never)).not.toThrow()
    const compiled = dialect.sqlToQuery(whereCapture[0] as never)
    expect(compiled.sql).toMatch(/embedding_last_attempt_at/)
    expect(compiled.sql).toMatch(/is null/i)
    // The cutoff Date must reach the param array as an ISO timestamp string,
    // not a JS Date instance (which would crash the pg driver). Find the
    // ISO string corresponding to a Date param.
    const isoCutoff = compiled.params.find(
      (p): p is string =>
        typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p)
    )
    expect(isoCutoff).toBeDefined()
  })

  it('processes multiple rows per invocation', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'a', attemptCount: 0 },
      { lookupKey: 'frag2', content: 'b', attemptCount: 1 },
    ])
    embedTextMock
      .mockResolvedValueOnce([1, 2, 3])
      .mockResolvedValueOnce(null)
    takeLastEmbedFailureMock.mockReturnValueOnce({ kind: 'threw', message: 'timeout' })

    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(embedTextMock).toHaveBeenCalledTimes(2)
    expect(updateCapture).toHaveLength(2)
    expect(updateCapture[0].set.embedding).toEqual([1, 2, 3])
    expect(updateCapture[1].set.embeddingAttemptCount).toBe(2)
  })
})
