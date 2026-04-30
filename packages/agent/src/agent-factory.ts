import { Agent } from '@mastra/core/agent'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { OpenRouterConfig } from './openrouter-config.js'

export interface IngestAgents {
  fragmenter: Agent
  entityExtractor: Agent
  wikiClassifier: Agent
  fragScorer: Agent
  wikiWriter: Agent
}

/**
 * Builds a fresh set of Mastra agents for a single ingest run.
 * Called once per job — not module-level. The config is sourced from
 * the `configs` table (encrypted via the crypto envelope) by core.
 */
export function createIngestAgents(config: OpenRouterConfig): IngestAgents {
  const or = createOpenRouter({ apiKey: config.apiKey })

  return {
    fragmenter: new Agent({
      id: 'fragmenter',
      name: 'Fragmenter',
      instructions: '',
      model: or(config.models.extraction),
    }),
    entityExtractor: new Agent({
      id: 'entity-extractor',
      name: 'EntityExtractor',
      instructions: '',
      model: or(config.models.extraction),
    }),
    wikiClassifier: new Agent({
      id: 'wiki-classifier',
      name: 'Marcel',
      instructions: '',
      model: or(config.models.classification),
    }),
    fragScorer: new Agent({
      id: 'frag-scorer',
      name: 'Judge',
      instructions: '',
      model: or(config.models.classification),
    }),
    // Quill — wiki body writer. Uses the wikiGeneration model slot
    // (Sonnet-class) and a 16k output cap so long wikis don't truncate.
    // The cap is enforced via AGENT_MODEL_SETTINGS in agents/caller.ts.
    wikiWriter: new Agent({
      id: 'wiki-writer',
      name: 'Quill',
      instructions: '',
      model: or(config.models.wikiGeneration),
    }),
  }
}
