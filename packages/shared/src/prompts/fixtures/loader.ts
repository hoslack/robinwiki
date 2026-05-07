import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

export interface PromptPreviewVars {
  fragments: string
  title: string
  date: string
  count: number
  timeline: string
  people: string
  existingWiki: string
  edits: string
  relatedWikis: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
// TODO: see .planning/phases/prompt-backend-reconcile/04-PLAN.md#known-limitation-runtime-yaml-path-resolution
// Fixture path inherits the same __dirname-relative fragility as loadSpec and
// readDefaultYaml. Deferred to a future 'prompt-path-resolution-hardening' phase —
// do NOT attempt a partial fix here (RESEARCH.md §"Path resolution note").
const FIXTURES_DIR = resolve(__dirname)

const fixtureCache = new Map<string, PromptPreviewVars>()

/**
 * Load the shared wiki-type preview fixture, returning the 9-variable input
 * map used by `renderPromptSpec` in the preview endpoint.
 *
 * All 10 wiki types share the same fixture today. The `slug` argument is kept
 * so per-slug specialization stays additive: drop `${slug}.yaml` alongside
 * `wiki-type-preview.yaml` and this loader will pick it up automatically.
 *
 * Cache semantics: results are cached by resolved path; repeated calls return
 * the SAME object reference. Consumers MUST NOT mutate the returned object.
 */
export function loadWikiTypePreviewFixture(slug?: string): PromptPreviewVars {
  const sharedPath = resolve(FIXTURES_DIR, 'wiki-type-preview.yaml')
  const specificPath = slug ? resolve(FIXTURES_DIR, `${slug}.yaml`) : null
  const path = specificPath && existsSync(specificPath) ? specificPath : sharedPath
  const cached = fixtureCache.get(path)
  if (cached) return cached
  const raw = readFileSync(path, 'utf-8')
  // SEC-L3: FAILSAFE_SCHEMA disables implicit type coercion — every unquoted
  // YAML scalar arrives as a string. `count` is quoted in the fixture; we
  // cast to Number at the boundary so the consumer sees the declared shape.
  const parsedRaw = loadYaml(raw, { schema: FAILSAFE_SCHEMA }) as Record<string, unknown>
  const parsed: PromptPreviewVars = {
    fragments: String(parsedRaw.fragments ?? ''),
    title: String(parsedRaw.title ?? ''),
    date: String(parsedRaw.date ?? ''),
    count: Number(parsedRaw.count ?? 0),
    timeline: String(parsedRaw.timeline ?? ''),
    people: String(parsedRaw.people ?? ''),
    existingWiki: String(parsedRaw.existingWiki ?? ''),
    edits: String(parsedRaw.edits ?? ''),
    relatedWikis: String(parsedRaw.relatedWikis ?? ''),
  }
  fixtureCache.set(path, parsed)
  return parsed
}
