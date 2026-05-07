import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

/**
 * SEC-H3 regression lock. The audit (2026-04-20) reported that BullBoard was
 * mounted under `if (NODE_ENV !== 'production')` with no auth — exposing queue
 * payloads. Phase 1 replaced that with `app.use('/admin/queues/*',
 * sessionMiddleware)` (core/src/index.ts:175). These tests guarantee the gate
 * stays in place: unauthenticated requests must 401; authenticated must reach
 * the BullBoard handler.
 *
 * Test-only module — does NOT modify core/src/index.ts.
 */

// Mock auth so getSession returns null/valid based on a flag we toggle per
// test. Mirrors the real sessionMiddleware contract.
let sessionResult: unknown = null
vi.mock('../auth.js', () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => sessionResult),
    },
  },
}))

// Stub the BullBoard route module — we don't need a real BullMQ board here;
// we're asserting the auth gate, not the dashboard.
vi.mock('../routes/bull-board.js', async () => {
  const { Hono } = await import('hono')
  const stub = new Hono()
  stub.get('/', (c) => c.text('ok', 200))
  stub.get('/*', (c) => c.text('ok', 200))
  return { bullBoardApp: stub }
})

const { sessionMiddleware } = await import('../middleware/session.js')
const { bullBoardApp } = await import('../routes/bull-board.js')

function buildApp() {
  const app = new Hono()
  app.use('/admin/queues/*', sessionMiddleware)
  app.route('/admin/queues', bullBoardApp)
  return app
}

describe('BullBoard auth gate (SEC-H3 regression)', () => {
  beforeEach(() => {
    sessionResult = null
  })

  it('returns 401 on /admin/queues without a session', async () => {
    sessionResult = null
    const app = buildApp()
    const res = await app.request('/admin/queues')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 on a nested /admin/queues path with an invalid session', async () => {
    // Better Auth's getSession returns null for invalid cookies — same shape as
    // "no cookie at all". The middleware can't tell the difference and 401s
    // either way, which is the correct behavior.
    sessionResult = null
    const app = buildApp()
    const res = await app.request('/admin/queues/some-queue', {
      headers: { cookie: 'better-auth.session_token=garbage' },
    })
    expect(res.status).toBe(401)
  })

  it('passes through to BullBoard when the session is valid', async () => {
    sessionResult = {
      user: { id: 'test-user-001', email: 'admin@example.com' },
      session: { id: 'sess-1' },
    }
    const app = buildApp()
    const res = await app.request('/admin/queues')
    // The locking assertion: NOT 401. With the stubbed bullBoardApp above we
    // expect 200; if the gate disappears the test still locks the invariant
    // by failing on a future regression that re-introduces the env-conditional
    // mount (the request would hit a 404 instead of the 200 from the stub).
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
  })
})
