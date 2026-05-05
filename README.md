# Robin

Robin is an AI-powered second brain that captures raw thoughts through conversation (MCP or web UI) and automatically structures them into a searchable knowledge base. Behind the scenes, a 6-stage AI pipeline extracts atomic ideas (fragments), classifies them into topic clusters (wikis), resolves people mentions, and stores everything in Postgres with vector embeddings for hybrid search.

## Architecture

Monorepo managed by pnpm workspaces + Turborepo.

```
core/           @robin/core    — Hono API server, MCP server, AI pipeline, workers
wiki/           @robin/wiki    — Next.js 16 web frontend (shadcn/ui)
packages/agent  @robin/agent   — LLM agent utilities, person resolution
packages/queue  @robin/queue   — BullMQ producer/consumer abstractions
packages/shared @robin/shared  — Shared types, lookup keys, slug helpers
packages/caslock @robin/caslock — CAS-based distributed locking
```

## Tech Stack

| Layer | Stack |
|-------|-------|
| API | Hono, Zod, better-auth |
| Database | PostgreSQL + pgvector, Drizzle ORM |
| Queue | Redis + BullMQ |
| AI | OpenRouter (Claude, embeddings), Mastra |
| Frontend | Next.js 16, React 19, Tailwind CSS, shadcn/ui |
| Tooling | TypeScript, Biome, Vitest, Turborepo, pnpm |

## Prerequisites

- **Node.js** >= 20 (enable corepack: `corepack enable`)
- **pnpm** >= 9 (installed automatically via corepack from `packageManager` field)
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **Redis** (used by BullMQ for job queues)

## Quick Start

```bash
# Enable corepack (provides the correct pnpm version)
corepack enable

# Clone and install
git clone https://github.com/withrobinhq/robin.git
cd robin
pnpm install

# Configure environment
cp core/.env.example core/.env

# Generate MASTER_KEY (required for encryption)
openssl rand -hex 32
# Paste the output into core/.env as MASTER_KEY=<value>

# Fill in the remaining values:
# - DATABASE_URL (Postgres with pgvector extension)
# - REDIS_URL
# - OPENROUTER_API_KEY
# - BETTER_AUTH_SECRET (32+ chars)
# - INITIAL_USERNAME / INITIAL_PASSWORD

# Ensure pgvector is enabled on your database
psql $DATABASE_URL -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# Push database schema
pnpm --filter @robin/core db:push

# Start dev servers (core API + wiki frontend)
pnpm dev
```

Core runs on `http://localhost:3000`, wiki on `http://localhost:8080`.

## Environment Variables

All variables are configured in `core/.env`. See `core/.env.example` for the full template.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | `postgresql://postgres@127.0.0.1:5432/robinwiki` | PostgreSQL connection string (must have pgvector) |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string for BullMQ job queues |
| `BETTER_AUTH_SECRET` | Yes | - | Session cookie signing secret (32+ chars) |
| `MASTER_KEY` | Yes | - | Root encryption key, 64 hex chars (`openssl rand -hex 32`) |
| `KEY_ENCRYPTION_SECRET` | Yes | - | AES-256-GCM key encryption secret (32+ chars) |
| `OPENROUTER_API_KEY` | Yes | - | OpenRouter API key for LLM calls and embeddings |
| `INITIAL_USERNAME` | Yes | - | Admin email address (created on first login via JIT) |
| `INITIAL_PASSWORD` | Yes | - | Admin password |
| `SERVER_PUBLIC_URL` | Yes | `http://localhost:3000` | Public URL for MCP endpoints, auth cookies |
| `WIKI_ORIGIN` | Yes | `http://localhost:8080` | Wiki frontend URL(s) for CORS (comma-separated) |
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | No | `development` | Node environment (`production` enables secure cookies) |
| `LOG_LEVEL` | No | `info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `WIKI_CLASSIFY_THRESHOLD` | No | `0.65` | LLM confidence threshold for filing fragments (0.0-1.0) |
| `ENABLE_BATCH_REGEN` | No | `true` | Enable midnight batch wiki regeneration cron |

## Scripts

### Root

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start all dev servers in parallel (Turborepo) |
| `pnpm build` | Build all workspaces |
| `pnpm typecheck` | Type-check all workspaces |
| `pnpm test` | Run tests across all workspaces |
| `pnpm lint` | Lint all workspaces |
| `pnpm format` | Format with Biome |
| `pnpm serve` | Start core + wiki with concurrently (alternative to `dev`) |
| `pnpm manifest` | Generate OpenAPI manifest and wiki client |

### Core (`@robin/core`)

| Script | Description |
|--------|-------------|
| `pnpm --filter @robin/core dev` | Start dev server with tsx watch |
| `pnpm --filter @robin/core build` | Compile TypeScript |
| `pnpm --filter @robin/core test` | Run Vitest tests |
| `pnpm --filter @robin/core db:generate` | Generate Drizzle migrations |
| `pnpm --filter @robin/core db:push` | Push schema to database |
| `pnpm --filter @robin/core mcp:inspect` | Launch MCP inspector |

### Wiki (`@robin/wiki`)

| Script | Description |
|--------|-------------|
| `pnpm --filter @robin/wiki dev` | Start Next.js dev server |
| `pnpm --filter @robin/wiki build` | Production build |
| `pnpm --filter @robin/wiki manifest` | Regenerate TypeScript client from OpenAPI spec |

## MCP Tools

Robin exposes an MCP server for Claude, ChatGPT, and other AI clients.

| Tool | Description |
|------|-------------|
| `log_entry` | Capture a thought — feeds the full 6-stage AI pipeline |
| `log_fragment` | Write a fragment directly to a known wiki (fast path) |
| `create_wiki` | Create a new wiki with auto-inferred type |
| `edit_wiki` | Update wiki content with edit history preservation |
| `list_wikis` | List all wikis with fragment counts and type info |
| `get_wiki` | Get wiki details with full body and fragment snippets |
| `get_fragment` | Get full fragment content by slug |
| `find_person` | Find a person by ID or fuzzy name search |
| `brief_person` | Get a formatted person briefing (no LLM call) |
| `search` | Hybrid BM25 + semantic search across all entities |
| `get_wiki_types` | List available wiki types and descriptors |
| `create_wiki_type` | Define a custom wiki type |
| `publish_wiki` | Publish a wiki with a stable public URL |
| `unpublish_wiki` | Unpublish a wiki (preserves slug for re-publish) |
| `get_timeline` | Audit timeline for a wiki and its fragments |

## API

The core server exposes a REST API alongside MCP. OpenAPI spec available at:

```
GET http://localhost:3000/openapi.json
```

Generate the TypeScript client for the wiki frontend:

```bash
pnpm --filter @robin/wiki openapi:generate
```

## Deploy

We've optimized deployments for Railway. Three strategies, in increasing order of independence:

| Strategy | Setup | Auto-updates | Customizable | Best for |
|---|---|---|---|---|
| **1. Template** (easy) | ~2 min | Yes — from upstream | No | Trying it out, hosted demos |
| **2. Fork + Re-point** | ~5 min | Via Railway's `Check for updates` | Yes | Personal use with optional upstream tracking |
| **3. Standalone (Eject)** | ~15 min | Manual `git pull` | Yes | Private instance, derivative product |

### Strategy 1 — Template

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/1hBtzC?referralCode=55-uGO&utm_medium=integration&utm_source=template&utm_campaign=github)

Connects directly to upstream. Auto-updates whenever we push to `main`.
**You can't customize the code, and your instance redeploys when we update upstream — including breaking changes.**
Best for trying Robin out or running a hosted demo.

### Strategy 2 — Fork + Re-point

1. [Fork this repo →](https://github.com/withrobinhq/robinwiki/fork)
2. Click the `Deploy on Railway` button above. This uses the published template to provision postgres + redis + `@robin/core` + `@robin/wiki` with all env vars pre-populated.
3. After the initial deploy completes, open each of `@robin/core` and `@robin/wiki` in turn. In **Settings → Source**, change the connected `Source Repo` from `withrobinhq/robinwiki` to your fork (`<your-username>/robinwiki`). Leave `Upstream Repo` alone — that's what powers Railway's `Check for updates` flow, which surfaces upstream changes as PRs against your fork.
4. Trigger a redeploy on each service. Railway now pulls from your fork; future pushes to your fork auto-deploy.

<!-- TODO: screenshot of Settings → Source panel with Source Repo field annotated -->

**You decide when to pull upstream updates, and you can edit the code.**
Best if you want stability with optional upstream tracking, or want to customize prompts, models, UI, etc.

> Why this works: the Railway template URL is hardcoded to deploy from upstream. Clicking the button alone — even from your fork's README — provisions services that pull from `withrobinhq/robinwiki`. Re-pointing the source after the initial deploy is the cleanest way to keep the template's env-var pre-population while running off your fork.

### Strategy 3 — Standalone (Eject)

Most independence, most setup. You own everything end-to-end — no upstream tracking, no `Check for updates` flow.

1. Fork or clone the repo.
2. Create a new Railway project (don't use the template).
3. Add a Postgres service — set the source image to `pgvector/pgvector:pg17`.
4. Add a Redis service — Railway's default Redis works.
5. Add a service for `@robin/core`: **Deploy from GitHub repo** → select your fork. Then in **Settings → Build → Railway Config File**, set the path to `railpack.core.json`.
6. Add a service for `@robin/wiki`: same flow, with `railpack.wiki.json`.
7. Set env vars manually for all four services — see `core/.env.example` or copy from a working template-based deploy.
8. Trigger initial deploy.

<!-- TODO: screenshot of Settings → Build → Railway Config File field -->

Trade-off: ~10 extra minutes of env-var setup that strategies 1 + 2 skip. No `Check for updates` — pull upstream changes by hand via `git pull`.

#### Keeping your fork in sync (Strategies 2 + 3)

```bash
git remote add upstream https://github.com/withrobinhq/robinwiki.git
git fetch upstream
git merge upstream/main
git push
```

## Contributing

### Linting and formatting

- **core/ and packages/**: [Biome](https://biomejs.dev/) for linting and formatting (`pnpm format`, `pnpm lint`)
- **wiki/**: [ESLint](https://eslint.org/) with `eslint-config-next` (wiki has its own config and does not use Biome)

### Workspace boundaries

The workspace packages (`@robin/agent`, `@robin/queue`, `@robin/shared`, `@robin/caslock`) have strict boundaries. Do not flatten them into core or merge packages together. Each package builds independently and exposes its own entry points.

### Branch workflow

Work on feature branches. Create a GitHub issue before starting work, then open a PR that references the issue.

## License

Private. All rights reserved.
