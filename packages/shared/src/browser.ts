/**
 * Browser-safe surface for @robin/shared.
 *
 * Import this in any code bundled for the browser (Next.js client,
 * Turbopack, esbuild for browser, etc.). Every re-export here must
 * be reachable WITHOUT pulling node-only modules (`node:fs`, `node:crypto`,
 * etc.) into the dependency graph.
 *
 * Adding a re-export that transitively imports `node:*` will break the
 * wiki's Turbopack client build with "the chunking context does not
 * support external modules". Keep this barrel disciplined.
 *
 * Node-side consumers may use either this barrel or the bare
 * `@robin/shared` barrel (which re-exports both this and `./node`).
 */
export * from './types/embedding.js'
export * from './types/entry.js'
export * from './types/fragment.js'
export * from './types/wiki.js'
export * from './types/config.js'
export * from './identity.js'
export * from './filename.js'
export * from './slug.js'
export * from './state-machine.js'
export * from './wiki-links.js'
export * from './env.js'
export * from './schemas/sidecar.js'
export * from './fragmentTitlePrefix.js'
