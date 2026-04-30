import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  loadWikiClassificationSpec,
  loadPeopleExtractionSpec,
  loadFragmentationSpec,
  loadWikiRelevanceSpec,
} from '../../prompts/index'
import { loadSpec } from '../../prompts/loader'

describe('wiki-classification', () => {
  const fixtures = {
    content: 'test fragment about exercise',
    wikis: 'health-log, work-project, fitness-goals',
  }

  it('loads and returns a valid PromptResult', () => {
    const result = loadWikiClassificationSpec(fixtures)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.meta).toHaveProperty('temperature')
    expect(result.meta).toHaveProperty('outputSchema')
  })

  it('renders system message with Marcel persona', () => {
    const result = loadWikiClassificationSpec(fixtures)
    expect(result.system).toContain('Marcel')
  })

  it('renders user template with substituted variables', () => {
    const result = loadWikiClassificationSpec(fixtures)
    expect(result.user).toContain('health-log, work-project, fitness-goals')
    expect(result.user).toContain('test fragment about exercise')
    expect(result.user).not.toContain('{{content}}')
    expect(result.user).not.toContain('{{wikis}}')
  })

  it('throws ZodError when required content is missing', () => {
    expect(() => loadWikiClassificationSpec({ wikis: 'foo' } as any)).toThrow(ZodError)
  })
})

describe('people-extraction', () => {
  const fixtures = { content: 'I met John and Elfie at the coffee shop today' }

  it('loads and returns a valid PromptResult', () => {
    const result = loadPeopleExtractionSpec(fixtures)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.meta).toHaveProperty('temperature')
    expect(result.meta).toHaveProperty('outputSchema')
  })

  it('renders system message with Elfie persona', () => {
    const result = loadPeopleExtractionSpec(fixtures)
    expect(result.system).toContain('Elfie')
  })

  it('renders user template with substituted content', () => {
    const result = loadPeopleExtractionSpec(fixtures)
    expect(result.user).toContain('I met John and Elfie')
    expect(result.user).not.toContain('{{content}}')
  })
})

describe('fragmentation', () => {
  const fixtures = { content: 'Long entry text about multiple topics including health and work' }

  it('loads and returns a valid PromptResult', () => {
    const result = loadFragmentationSpec(fixtures)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.meta).toHaveProperty('temperature')
    expect(result.meta).toHaveProperty('outputSchema')
  })

  it('renders system message with Elfie persona', () => {
    const result = loadFragmentationSpec(fixtures)
    expect(result.system).toContain('Elfie')
  })

  it('renders user template with substituted content', () => {
    const result = loadFragmentationSpec(fixtures)
    expect(result.user).toContain('Long entry text about multiple topics')
    expect(result.user).not.toContain('{{content}}')
  })

  it('renders OUTPUT FIELDS section in template', () => {
    const result = loadFragmentationSpec(fixtures)
    expect(result.user).toContain('[OUTPUT FIELDS')
    expect(result.user).toContain('sourceSpan')
    expect(result.user).toContain('confidence')
  })

  it('does NOT inject wordCount/fragmentTarget into the rendered template (v6)', () => {
    // v6 dropped the word-count → target heuristic in favour of topic
    // coherence. The loader still computes a code-side ceiling, but the
    // prompt body must not nudge the LLM toward a target number.
    const result = loadFragmentationSpec({ content: 'short entry' })
    expect(result.user).not.toContain('approximately 2 words')
    expect(result.user).not.toContain('approximately 1 fragments')
    expect(result.user).not.toMatch(/\{\{wordCount\}\}|\{\{fragmentTarget\}\}/)
  })
})

describe('wiki-relevance', () => {
  const fixtures = {
    wikiName: 'Health Tracking',
    threadType: 'log',
    threadDescription: 'A log of health-related activities',
    fragmentContent: 'I went for a 5k run this morning',
  }

  it('loads and returns a valid PromptResult', () => {
    const result = loadWikiRelevanceSpec(fixtures)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.meta).toHaveProperty('temperature')
    expect(result.meta).toHaveProperty('outputSchema')
  })

  it('renders system message with Judge persona', () => {
    const result = loadWikiRelevanceSpec(fixtures)
    expect(result.system).toContain('Judge')
  })

  it('renders user template with substituted variables', () => {
    const result = loadWikiRelevanceSpec(fixtures)
    expect(result.user).toContain('Health Tracking')
    expect(result.user).toContain('I went for a 5k run this morning')
    expect(result.user).not.toContain('{{wikiName}}')
    expect(result.user).not.toContain('{{fragmentContent}}')
  })

  it('throws ZodError when required fragmentContent is missing', () => {
    expect(() =>
      loadWikiRelevanceSpec({
        wikiName: 'x',
        threadType: 'log',
        threadDescription: 'desc',
      } as any)
    ).toThrow(ZodError)
  })
})

describe('modification stack', () => {
  it('wiki-classification has output.strict: true (classification)', () => {
    const result = loadWikiClassificationSpec({ content: 'test', wikis: 't1' })
    expect(result.meta.temperature).toBe(0.1)
  })

  it('people-extraction does NOT have output.strict (extraction)', () => {
    const result = loadPeopleExtractionSpec({ content: 'test' })
    expect(result.meta.temperature).toBe(0)
  })

  it('fragmentation does NOT have output.strict (extraction)', () => {
    const result = loadFragmentationSpec({ content: 'test' })
    expect(result.meta.temperature).toBe(0.2)
  })

  it('wiki-relevance has output.loose: true (scoring)', () => {
    const result = loadWikiRelevanceSpec({
      wikiName: 'x',
      threadType: 'log',
      threadDescription: 'd',
      fragmentContent: 'f',
    })
    expect(result.meta.temperature).toBe(0.2)
  })
})

const standaloneSpecs: Array<{ filename: string; subdir?: string }> = [
  { filename: 'fragmentation.yaml' },
  { filename: 'fragment-relevance.yaml' },
  { filename: 'people-extraction.yaml' },
  { filename: 'wiki-classification.yaml' },
  { filename: 'wiki-relevance.yaml' },
  { filename: 'person-summary.yaml', subdir: 'person-summary' },
]

describe('standalone (system-only) specs', () => {
  for (const { filename, subdir } of standaloneSpecs) {
    describe(filename, () => {
      it('has system_only: true', () => {
        const spec = loadSpec(filename, subdir)
        expect(spec.system_only).toBe(true)
      })

      it('is parseable via PromptSpecSchema', () => {
        const spec = loadSpec(filename, subdir)
        expect(spec.name).toBeTypeOf('string')
        expect(spec.template).toBeTypeOf('string')
      })
    })
  }
})
