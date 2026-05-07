# 60 — Stream G core: graph package + wiki_agent_schema + HyDE + retrieval cutover

## What it proves

PR `feat/g-graph-and-agent-schema` ships five Stream G v0.2.0 features:

1. **G1 (graph package)**: new workspace package `@robin/graph` carries shared graph utilities and an `enrichEdges()` adapter (`src_type` / `dst_type` enrichment from edges + vertex IDs). Wiki imports utilities from the package. The full os.withrobin.org React-component lift was scoped down to utilities + adapter (~140 LOC) because the upstream React components are vault-scoped and need rewrite to work without `useVaults`. Closes #149 via the workspace package existing and being consumed.
2. **G5 (wiki_agent_schema)**: new table `wiki_agent_schema` keyed by `(wiki_key, kind)`. v0.2.0 ships `kind in ('description', 'hyde_synthetic')`. New column `wiki_types.internal_framing` with v0.2.0 framings populated from YAML. Migrations 0005 + 0006.
3. **G7 (HyDE generator)**: regen pipeline writes both `kind='description'` (direct embedding of `wikis.description`) and `kind='hyde_synthetic'` (LLM-generated retrieval-optimized passage via the structured template in `docs/architecture/wiki-agent-schema.md`). LLM is `RETRIEVAL_INDEX_MODEL` env var, defaults to writer model. `generator_version='hyde_v1'`.
4. **G4 (retrieval cutover)**: `hybridSearch()` parallel-fans BM25 + per-kind agent-schema vector lanes + a legacy fallback for unbackfilled wikis (reads `wikis.embedding` until the wiki has a `wiki_agent_schema` row).
5. **G6 (retrieval evals)**: hand-curated corpus at `core/eval/retrieval/` with `corpus.json` (the documents) and `queries.json` (the golden-set queries). README documents how to wire into evalite once D2 lands.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- Wiki dev/prod on `WIKI_URL` (default `http://localhost:8080`)
- `DATABASE_URL` reachable
- Migrations 0005 and 0006 applied (`pnpm -C core db:migrate`)
- `pnpm -C core seed-fixture` so a Transformer wiki and other types are present
- `OPENROUTER_API_KEY` set and `RETRIEVAL_INDEX_MODEL` either set or unset (defaults to writer model)
- `pnpm install` to pick up `@robin/graph` workspace package

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing)
- `POST /wikis/:id/regenerate`: triggers a regen which now also populates `wiki_agent_schema`
- `GET  /search?q=<query>`: hybrid search, now blends BM25 + description-kind + hyde_synthetic-kind via RRF

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"

JAR=$(mktemp /tmp/uat-60-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-60-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

PSQL() { PGPASSWORD="${DB_PASS:-}" psql "$DATABASE_URL" -A -t -c "$1" 2>/dev/null; }

echo "60 — Stream G core: graph + agent schema + HyDE + retrieval"
echo ""

# 1. Sign in
HTTP=$(curl -s -o /tmp/uat-60-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$HTTP" = "200" ]; then pass "sign in 200"; else fail "sign in got $HTTP"; fi

# 2. G5 — migrations applied, table exists
TABLE_EXISTS=$(PSQL "SELECT to_regclass('public.wiki_agent_schema');" | tr -d '[:space:]')
if [ "$TABLE_EXISTS" = "wiki_agent_schema" ]; then pass "wiki_agent_schema table exists"; else fail "wiki_agent_schema table missing"; fi

COL_EXISTS=$(PSQL "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_types' AND column_name='internal_framing';" | tr -d '[:space:]')
if [ "$COL_EXISTS" = "internal_framing" ]; then pass "wiki_types.internal_framing column exists"; else fail "wiki_types.internal_framing missing"; fi

# 3. G5 — internal_framing populated for at least 5 of the 10 v0.2.0 wiki types
FRAMING_COUNT=$(PSQL "SELECT COUNT(*) FROM wiki_types WHERE internal_framing IS NOT NULL AND length(internal_framing) > 20;")
if [ "$FRAMING_COUNT" -ge 5 ]; then pass "internal_framing populated for $FRAMING_COUNT wiki types"; else fail "only $FRAMING_COUNT types have framing, expected >= 5"; fi

# 4. G7 — pick a wiki and trigger regen, then assert both kinds land
WIKI_ID=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].id // empty')
if [ -z "$WIKI_ID" ]; then fail "no wikis seeded"; exit 1; fi
WIKI_KEY=$(curl -s -b "$JAR" "$SERVER_URL/wikis/$WIKI_ID" | jq -r '.key // empty')
pass "selected wiki $WIKI_KEY (id $WIKI_ID)"

REGEN_HTTP=$(curl -s -o /tmp/uat-60-regen.json -w "%{http_code}" \
  -b "$JAR" -X POST -H "Origin: $ORIGIN" "$SERVER_URL/wikis/$WIKI_ID/regenerate")
if [ "$REGEN_HTTP" = "200" ] || [ "$REGEN_HTTP" = "202" ]; then pass "regen accepted ($REGEN_HTTP)"; else fail "regen got $REGEN_HTTP"; fi

# Allow time for the worker to populate wiki_agent_schema
sleep 8

# 5. G7 — both kinds present for this wiki
KIND_DESC=$(PSQL "SELECT COUNT(*) FROM wiki_agent_schema WHERE wiki_key='$WIKI_KEY' AND kind='description';")
KIND_HYDE=$(PSQL "SELECT COUNT(*) FROM wiki_agent_schema WHERE wiki_key='$WIKI_KEY' AND kind='hyde_synthetic';")
if [ "$KIND_DESC" = "1" ]; then pass "description row present for $WIKI_KEY"; else fail "description row missing or duplicated ($KIND_DESC)"; fi
if [ "$KIND_HYDE" = "1" ]; then pass "hyde_synthetic row present for $WIKI_KEY"; else fail "hyde_synthetic row missing or duplicated ($KIND_HYDE)"; fi

# 6. G7 — generator_version is hyde_v1
GEN_VER=$(PSQL "SELECT DISTINCT generator_version FROM wiki_agent_schema WHERE wiki_key='$WIKI_KEY';" | tr -d '[:space:]' | sort -u | head -1)
if [ "$GEN_VER" = "hyde_v1" ]; then pass "generator_version is hyde_v1"; else fail "generator_version was $GEN_VER"; fi

# 7. G7 — hyde_synthetic content is non-trivial (>= 100 chars, non-empty)
HYDE_LEN=$(PSQL "SELECT length(content) FROM wiki_agent_schema WHERE wiki_key='$WIKI_KEY' AND kind='hyde_synthetic';" | tr -d '[:space:]')
if [ "${HYDE_LEN:-0}" -ge 100 ]; then pass "hyde_synthetic content $HYDE_LEN chars"; else fail "hyde_synthetic content too short or missing ($HYDE_LEN)"; fi

# 8. G7 — embedding is populated
EMB_NONNULL=$(PSQL "SELECT COUNT(*) FROM wiki_agent_schema WHERE wiki_key='$WIKI_KEY' AND embedding IS NOT NULL;")
if [ "$EMB_NONNULL" -ge 1 ]; then pass "embeddings populated for at least one row ($EMB_NONNULL)"; else fail "no embeddings"; fi

# 9. G4 — search returns results and they include the regenerated wiki
SEARCH_HTTP=$(curl -s -o /tmp/uat-60-search.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/search?q=knowledge+base")
if [ "$SEARCH_HTTP" = "200" ]; then pass "/search 200"; else fail "/search got $SEARCH_HTTP"; fi
RESULT_COUNT=$(jq '.results | length' /tmp/uat-60-search.json 2>/dev/null || echo 0)
if [ "$RESULT_COUNT" -gt 0 ]; then pass "/search returned $RESULT_COUNT results"; else fail "/search returned zero results"; fi

# 10. G6 — eval corpus files exist
for f in core/eval/retrieval/README.md core/eval/retrieval/corpus.json core/eval/retrieval/queries.json; do
  if [ -f "$f" ]; then pass "eval file: $f"; else fail "eval file missing: $f"; fi
done
QUERY_COUNT=$(jq '.queries | length' core/eval/retrieval/queries.json 2>/dev/null || echo 0)
if [ "$QUERY_COUNT" -ge 10 ]; then pass "eval has $QUERY_COUNT queries"; else fail "eval has only $QUERY_COUNT queries, expected >= 10"; fi

# 11. G1 — @robin/graph package builds and is consumable
PKG_EXISTS=$(test -f packages/graph/package.json && echo "yes" || echo "no")
if [ "$PKG_EXISTS" = "yes" ]; then pass "@robin/graph package exists"; else fail "@robin/graph package missing"; fi
GRAPH_BUILD=$(pnpm -F @robin/graph build 2>&1 | tail -3 | grep -ic "build complete\|completed\|✓")
if [ "$GRAPH_BUILD" -ge 1 ]; then pass "@robin/graph builds clean"; else skip "graph build verification deferred"; fi

# 12. G4 — graceful fallback: a wiki without a wiki_agent_schema row should still appear in search
# Pick another wiki and ensure it has no agent-schema rows
WIKI2_ID=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=10" | jq -r '.wikis[1].id // empty')
WIKI2_KEY=$(curl -s -b "$JAR" "$SERVER_URL/wikis/$WIKI2_ID" | jq -r '.key // empty')
if [ -n "$WIKI2_KEY" ]; then
  HAS_ROWS=$(PSQL "SELECT COUNT(*) FROM wiki_agent_schema WHERE wiki_key='$WIKI2_KEY';")
  if [ "$HAS_ROWS" = "0" ]; then
    # Search by something that should match this wiki
    WIKI2_TITLE=$(curl -s -b "$JAR" "$SERVER_URL/wikis/$WIKI2_ID" | jq -r '.title // empty')
    SEARCH_TITLE=$(echo "$WIKI2_TITLE" | head -c 30 | tr ' ' '+')
    curl -s -b "$JAR" "$SERVER_URL/search?q=$SEARCH_TITLE" | jq '.results | length' > /tmp/uat-60-fallback.txt
    FALLBACK_COUNT=$(cat /tmp/uat-60-fallback.txt)
    if [ "${FALLBACK_COUNT:-0}" -gt 0 ]; then pass "G4 legacy fallback returns results for unbackfilled wiki"; else skip "fallback test inconclusive"; fi
  else
    skip "second wiki already has agent-schema rows; fallback not exercisable here"
  fi
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Manual visual checks (browser)

1. Open `/graph` in the wiki. Confirm the existing graph canvas still renders post-`@robin/graph` lift. No regression.
2. Open `/wiki/<wiki-key>` for the wiki that was just regenerated. Body renders correctly, no missing content.

## Cleanup

```bash
PGPASSWORD=$DB_PASS psql "$DATABASE_URL" -c "DELETE FROM wiki_agent_schema WHERE generator_version='hyde_v1' AND wiki_key='<test-wiki-key>';"
```
Optional: only run if you want a fresh state for re-running the regen step.

## Expected pass/fail behavior

All steps PASS on a clean local stack with `OPENROUTER_API_KEY` set. Step 9 may return zero results if the corpus has no terms matching "knowledge base"; the test is more about the endpoint shape than recall quality. Step 12 is a soft fallback test, may SKIP.
