-- Stream D / D6 — empty-wiki bootstrap. The wiki_agent_schema table holds
-- the machine-side index layer for retrieval: per-wiki rows tagged with a
-- `kind` enum that signals what's encoded in `content` and `embedding`.
--
-- Coordinated with Stream G (HyDE/retrieval). G writes `kind='hyde_synthetic'`
-- rows when a wiki has fragments. D6 writes `kind='description'` rows on
-- wiki create — using the user-supplied description as the bootstrap signal
-- so a brand-new empty wiki participates in retrieval before any fragments
-- have been classified into it.
--
-- Idempotent uniqueness: (wiki_id, kind) — at most one description-row and
-- one hyde_synthetic-row per wiki. Refreshing the description content is an
-- UPDATE, not a second INSERT.

CREATE TABLE IF NOT EXISTS "wiki_agent_schema" (
  "id" text PRIMARY KEY NOT NULL,
  "wiki_id" text NOT NULL,
  "kind" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "embedding" vector(1536),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "wiki_agent_schema_wiki_kind_uidx" UNIQUE ("wiki_id", "kind")
);

CREATE INDEX IF NOT EXISTS "wiki_agent_schema_wiki_id_idx"
  ON "wiki_agent_schema" ("wiki_id");
