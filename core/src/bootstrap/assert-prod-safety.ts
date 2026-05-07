import { assertProdEnv, ProdSafetyError } from './env.js'
import { logger } from '../lib/logger.js'

export { ProdSafetyError } from './env.js'

/**
 * The canonical list of pre-auth routes mounted in core/src/index.ts.
 * EVERY top-level `app.route(...)` or `app.{get,post,...}(...)` mounted before
 * `app.use('/api/auth/*', ...)` MUST appear here OR self-apply session
 * middleware (admin, admin/queues).
 *
 * Tests in core/src/__tests__/route-allowlist.test.ts (Plan 05) assert the
 * source-tree mount surface matches this list. Adding a new public route
 * without updating this constant fails the test.
 *
 * Path shape: explicit single paths only (no `/published/*` wildcard prefix
 * — the published surface is just the single nanoid-token route). The
 * `/api/auth/*` entry is the lone wildcard because better-auth manages its
 * own internal route surface.
 */
export const PUBLIC_ROUTES = [
  // Backend-root landing page — Railway / direct-origin users land here and
  // see a pointer to WIKI_ORIGIN. No state, no secrets.
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/openapi.json' },
  { method: 'GET', path: '/favicon.ico' },
  { method: 'GET', path: '/system/status' },
  { method: 'GET', path: '/published/wiki/:nanoid' },
  { method: 'POST', path: '/auth/recover' },
  // /api/auth/* is delegated to better-auth's own handler — its public
  // surface is managed by that library, not by the Robin app shell.
  { method: 'ALL', path: '/api/auth/*' },
] as const

/**
 * A safety check MUST throw on failure. The aggregator catches every throw
 * and re-aggregates so operators see one message listing every problem
 * instead of a piecemeal log fed by repeated boot attempts.
 */
interface SafetyCheck {
  name: string
  run: () => void | Promise<void>
}

const defaultChecks: SafetyCheck[] = [
  // Env-only runtime checks. assertProdEnv covers the full required[] list:
  // DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, MASTER_KEY, KEY_ENCRYPTION_SECRET,
  // WIKI_ORIGIN, JOB_SIGNING_SECRET, RECOVERY_SECRET, SERVER_PUBLIC_URL (https-in-prod).
  //
  // Structural checks (CORS strict-mode, BullBoard auth gate, default-deny
  // route mounting) DO NOT live here — they are unit tests in
  // core/src/__tests__/route-allowlist.test.ts (and equivalents). Putting
  // them at runtime would re-introspect the live app at boot, which is
  // wasted work; tests catch the regression at CI time.
  { name: 'env vars (assertProdEnv)', run: assertProdEnv },
]

/**
 * Run every prod-safety check at boot. In production, any failure aborts
 * the boot with a single aggregated `ProdSafetyError` (rethrown). In
 * non-production, failures log at warn level and boot continues.
 *
 * SEC-DESIGN-PROD-GATE: this is the SINGLE entry point that says "is this
 * server safe to ship to prod". Future regressions must show up here.
 *
 * The `checks` argument is overridable for tests — pass an injected list
 * of {name, run} pairs to exercise the aggregator without monkey-patching
 * a module-level const.
 */
export async function assertProdSafety(
  checks: SafetyCheck[] = defaultChecks,
): Promise<void> {
  const failures: { name: string; err: unknown }[] = []
  for (const check of checks) {
    try {
      await check.run()
    } catch (err) {
      failures.push({ name: check.name, err })
    }
  }

  if (failures.length === 0) return

  const isProd = process.env.NODE_ENV === 'production'
  const summary = failures
    .map((f) => `  - ${f.name}: ${(f.err as Error)?.message ?? String(f.err)}`)
    .join('\n')

  if (isProd) {
    const aggregated = new ProdSafetyError(
      `${failures.length} prod-safety check(s) failed:\n${summary}`,
    )
    logger.fatal(
      { failures: failures.map((f) => f.name) },
      aggregated.message,
    )
    throw aggregated
  }

  logger.warn(
    { failures: failures.map((f) => f.name) },
    `assertProdSafety: ${failures.length} prod-safety check(s) failed (dev — continuing):\n${summary}`,
  )
}
