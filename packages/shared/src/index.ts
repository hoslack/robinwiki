/**
 * Kitchen-sink barrel for @robin/shared.
 *
 * Re-exports BOTH `./browser` and `./node`, which makes this the most
 * convenient import for node-side consumers (core, queue, agent,
 * scripts) — they get every export in one place.
 *
 * **Do NOT import from this barrel in browser/client code** — it pulls
 * in node-only modules (`node:fs` via `./prompts` and `./fixtures`)
 * and will break Turbopack client bundling. Use `@robin/shared/browser`
 * for browser-safe imports.
 */
export * from './browser.js'
export * from './node.js'
