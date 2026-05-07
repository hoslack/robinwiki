import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Required env vars must be present before env.js is imported, otherwise
// `createConfigVar` in env.ts trips its own Zod gate at module load.
const baseProdlikeEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/robin_test',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  MASTER_KEY: 'a'.repeat(64),
  KEY_ENCRYPTION_SECRET: 'b'.repeat(40),
  INITIAL_USERNAME: 'admin@example.com',
  INITIAL_PASSWORD: 'password123',
  OPENROUTER_API_KEY: 'sk-test',
  SERVER_PUBLIC_URL: 'https://api.example.com',
  WIKI_ORIGIN: 'https://wiki.example.com',
}
for (const [k, v] of Object.entries(baseProdlikeEnv)) {
  process.env[k] = v
}

const { assertProdSafety, ProdSafetyError, PUBLIC_ROUTES } = await import(
  '../assert-prod-safety.js'
)

describe('PUBLIC_ROUTES allowlist', () => {
  it('contains the canonical pre-auth surface', () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path)
    expect(paths).toContain('/health')
    expect(paths).toContain('/openapi.json')
    expect(paths).toContain('/favicon.ico')
    expect(paths).toContain('/system/status')
    expect(paths).toContain('/published/wiki/:nanoid')
    expect(paths).toContain('/auth/recover')
    expect(paths).toContain('/api/auth/*')
  })

  it('uses concrete paths, not wildcard prefixes for /published', () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path)
    expect(paths).not.toContain('/published/*')
  })
})

describe('assertProdSafety aggregator', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = 'test'
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.restoreAllMocks()
  })

  it('resolves silently when every check passes (dev)', async () => {
    process.env.NODE_ENV = 'development'
    const checks = [{ name: 'noop', run: () => undefined }]
    await expect(assertProdSafety(checks)).resolves.toBeUndefined()
  })

  it('logs a warn and continues in dev when a check throws', async () => {
    process.env.NODE_ENV = 'development'
    const { logger } = await import('../../lib/logger.js')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

    const checks = [
      {
        name: 'fails-loud',
        run: () => {
          throw new ProdSafetyError('boom')
        },
      },
    ]

    await expect(assertProdSafety(checks)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [, message] = warnSpy.mock.calls[0] as [unknown, string]
    expect(message).toContain('fails-loud')
    expect(message).toContain('boom')
  })

  it('throws an aggregated ProdSafetyError in production when any check fails', async () => {
    process.env.NODE_ENV = 'production'
    const { logger } = await import('../../lib/logger.js')
    vi.spyOn(logger, 'fatal').mockImplementation(() => undefined as never)

    const checks = [
      {
        name: 'env-vars',
        run: () => {
          throw new ProdSafetyError('missing FOO')
        },
      },
      {
        name: 'second-check',
        run: () => {
          throw new ProdSafetyError('also missing BAR')
        },
      },
    ]

    await expect(assertProdSafety(checks)).rejects.toBeInstanceOf(ProdSafetyError)
    await expect(assertProdSafety(checks)).rejects.toThrow(/2 prod-safety check\(s\) failed/)
    await expect(assertProdSafety(checks)).rejects.toThrow(/missing FOO/)
    await expect(assertProdSafety(checks)).rejects.toThrow(/also missing BAR/)
  })
})
