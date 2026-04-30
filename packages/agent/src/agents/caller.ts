/**
 * Typed caller factory for Mastra agents.
 *
 * Creates DI-friendly functions backed by Mastra agents. Stages receive these
 * as deps — they never import Agent directly, keeping Mastra as an
 * implementation detail and tests simple (mock the function, return typed data).
 *
 * Retry contract:
 *   Mastra layer: 2 retries for transient errors (429, 500, 502, 503)
 *   BullMQ layer: handles persistent failures (outages, DB errors)
 *   See .planning/mastra-agents-plan.md for full retry design.
 */

import type { Agent } from '@mastra/core/agent'
import type { ZodType } from 'zod'

/** Retry config for Mastra agent calls. */
export const AGENT_RETRY_CONFIG = {
  maxRetries: 2,
  retryableStatuses: [429, 500, 502, 503],
  backoff: { initial: 1000, multiplier: 3 }, // 1s, 3s
} as const

/**
 * Output token cap shared by every agent.generate() call.
 *
 * Sonnet 4.6 supports 16k output tokens; the OpenRouter SDK default is
 * ~4096, which silently truncated long wiki regen output (issue #257).
 * Raising the cap globally is safe because shorter prompts simply finish
 * sooner — the cap is an upper bound, not a target length.
 */
export const AGENT_MAX_OUTPUT_TOKENS = 16000

/** Model settings passed to every agent.generate() call. */
export const AGENT_MODEL_SETTINGS = {
  maxRetries: AGENT_RETRY_CONFIG.maxRetries,
  maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
} as const

/**
 * Creates a typed caller for structured JSON output.
 * The Zod schema validates the LLM response; the caller returns the parsed object.
 */
export function createTypedCaller<T>(agent: Agent, schema: ZodType<T>) {
  return async (system: string, user: string): Promise<T> => {
    const result = await agent.generate(user, {
      system,
      structuredOutput: { schema },
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    return result.object as T
  }
}

/**
 * Creates a string caller for free-form text output (wiki regen, person synthesis).
 * No schema validation — returns the raw text response.
 */
export function createStringCaller(agent: Agent) {
  return async (system: string, user: string): Promise<string> => {
    const result = await agent.generate(user, {
      system,
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    return result.text
  }
}
