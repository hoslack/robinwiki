import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SEC-H2 boot gate. assertProdEnv() must:
 *   - throw `ProdSafetyError` when NODE_ENV=production and SERVER_PUBLIC_URL
 *     is missing or http://
 *   - succeed when NODE_ENV=production and SERVER_PUBLIC_URL is https://
 *   - succeed in dev (NODE_ENV != production) regardless of URL scheme
 *
 * Phase 6 / Plan 04 refactored assertProdEnv to throw `ProdSafetyError`
 * instead of calling `process.exit(1)` so the `assertProdSafety` aggregator
 * can collect every failure into a single boot-time error message.
 */

const originalEnv = { ...process.env }

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
})

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, originalEnv)
  vi.resetModules()
})

async function loadAssert(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return import('../env.js')
}

describe('assertProdEnv — SEC-H2 cookie gate', () => {
  it('throws in production when SERVER_PUBLIC_URL is http://', async () => {
    const mod = await loadAssert({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/robin',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'a'.repeat(40),
      RECOVERY_SECRET: 'b'.repeat(40),
      MASTER_KEY: 'a'.repeat(64),
      KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
      JOB_SIGNING_SECRET: 'd'.repeat(40),
      INITIAL_USERNAME: 'admin@example.com',
      INITIAL_PASSWORD: 'password123',
      OPENROUTER_API_KEY: 'sk-test',
      SERVER_PUBLIC_URL: 'http://api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com',
    })

    expect(() => mod.assertProdEnv()).toThrow(mod.ProdSafetyError)
    expect(() => mod.assertProdEnv()).toThrow(/SERVER_PUBLIC_URL must start with https:\/\//)
  })

  it('passes in production when SERVER_PUBLIC_URL is https://', async () => {
    const mod = await loadAssert({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/robin',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'a'.repeat(40),
      RECOVERY_SECRET: 'b'.repeat(40),
      MASTER_KEY: 'a'.repeat(64),
      KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
      JOB_SIGNING_SECRET: 'd'.repeat(40),
      INITIAL_USERNAME: 'admin@example.com',
      INITIAL_PASSWORD: 'password123',
      OPENROUTER_API_KEY: 'sk-test',
      SERVER_PUBLIC_URL: 'https://api.example.com',
      WIKI_ORIGIN: 'https://wiki.example.com',
    })

    expect(() => mod.assertProdEnv()).not.toThrow()
  })

  it('passes in development with http://localhost SERVER_PUBLIC_URL', async () => {
    const mod = await loadAssert({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/robin',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'a'.repeat(40),
      MASTER_KEY: 'a'.repeat(64),
      KEY_ENCRYPTION_SECRET: 'c'.repeat(40),
      INITIAL_USERNAME: 'admin@example.com',
      INITIAL_PASSWORD: 'password123',
      OPENROUTER_API_KEY: 'sk-test',
      SERVER_PUBLIC_URL: 'http://localhost:3000',
      WIKI_ORIGIN: 'http://localhost:8080',
    })

    expect(() => mod.assertProdEnv()).not.toThrow()
  })
})
