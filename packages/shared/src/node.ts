/**
 * Node-only surface for @robin/shared.
 *
 * Modules in this barrel transitively import `node:fs`, `node:crypto`,
 * or other node-only APIs. Bundling this for the browser will fail
 * at chunking: "the chunking context does not support external modules".
 *
 * Use only from node-side workspaces (core, queue, agent, scripts).
 * Browser/client code should NOT import from `@robin/shared/node`
 * or from the bare `@robin/shared` barrel.
 */
export * from './prompts/index.js'
export * from './fixtures/index.js'
