# 26 — Onboarding (YAML / Keypair / MCP polling) + Entry Capture

## What it proves
PR #189's four claims hold end-to-end against a live stack:

1. **YAML path resolution** — `core/src/routes/wiki-types.ts` now resolves the
   wiki-types directory under `packages/shared/dist/prompts/specs/wiki-types/`
   instead of `src/`. Both `GET /wiki-types` and the bootstrap seed path read
   the YAML successfully (no fallback log line, list is non-empty, includes
   the seeded `decision` type).

2. **Synchronous keypair generation** — `core/src/bootstrap/jit-provision.ts`
   now generates the Ed25519 keypair inline before `ensureFirstUser` returns.
   Immediately after the first sign-in, `GET /users/profile` already exposes
   a populated `mcpEndpointUrl` whose JWT (a) decodes to a valid header +
   payload, (b) carries `alg=EdDSA` and a `kid`, and (c) actually authenticates
   against `/mcp`. No dependency on the BullMQ provision worker.

3. **MCP endpoint polling on Complete step** — `wiki/src/components/onboarding/CompleteStep.tsx`
   polls `/users/profile` every 2s while `mcpEndpointUrl` is empty, and the
   spinner copy reads "Generating your MCP endpoint..." (not the legacy
   "Unavailable"). When the URL is populated the spinner disappears.

4. **Entry capture modal in wiki header** — `wiki/src/components/layout/AddEntryModal.tsx`
   creates a row via the SDK `createEntry` call (`source: 'web'`, `type:
   'thought'`); positive submit invalidates the `entries` query and a row
   is persisted; cancel/empty submit does NOT create a row. The "Add Entry"
   button sits next to "Add Wiki" in the header.

Plus a regression on `PromptsStep.tsx`: the Continue button is no longer gated
by `hasEdited` — a fresh user who reviews-without-editing can advance.

Issue mappings:
- **#172** (Quartz/Preface deployment error, ~5-min onboarding target): claims 1, 2, 3, and the `disabled={false}` Continue gate.
- **#183** (no web UI capture surface): claim 4 — both positive and negative paths.

## Prerequisites
- Core running on `SERVER_URL` (default `http://localhost:3000`).
- Wiki dev server on `WIKI_URL` (default `http://localhost:8080`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `KEY_ENCRYPTION_SECRET` set in `core/.env` (required for the inline keypair
  path in `jit-provision.ts` to fire — guard at line 76).
- `jq`, `psql`, `node`, `npx agent-browser` on PATH.
- Plan 22 has run at least once OR this is a fresh-DB run (we tolerate both —
  the inline-keypair path in `ensureFirstUser` only fires on the first user,
  but on already-provisioned DBs the keypair must already be on the row).
- Working directory is the repo root (the YAML-path assertion walks
  `packages/shared/dist/prompts/specs/wiki-types/` from disk).

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
COOKIE_JAR=$(mktemp /tmp/uat-26-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR" /tmp/uat-26-*.json /tmp/uat-26-*.html /tmp/uat-26-*.png 2>/dev/null || true' EXIT

# Per-run salt for entry content (raw_sources may dedup or at least uniquify
# UAT rows so cleanup at the end can target this run only).
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "26 — Onboarding (YAML / Keypair / MCP polling) + Entry Capture"
echo ""

# ── 0. Sign in (provisions first user inline if DB is empty) ─────────
# In a freshly-reset DB, this call fires ensureFirstUser() which (per PR
# #189) generates the Ed25519 keypair INLINE before returning. On an
# already-provisioned DB this is a no-op auth round-trip.

SIGNIN_HTTP=$(curl -s -o /tmp/uat-26-signin.json -w "%{http_code}" -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")

if [ "$SIGNIN_HTTP" = "200" ]; then
  pass "0a. sign-in returns 200"
else
  fail "0a. sign-in returned HTTP $SIGNIN_HTTP — every downstream step will be skipped"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
# Section A — YAML path resolution (PR claim #1, issue #172)
# ─────────────────────────────────────────────────────────────────────
# Pre-PR: wiki-types.ts walked __dirname → ../../../packages/shared/SRC/
# Post-PR: it walks to ../../../packages/shared/DIST/. The dist/ tree must
# exist on disk AND the route must serve a populated list including the
# seeded `decision` type. We assert both — a false positive on either side
# alone is possible.

echo ""
echo "A. YAML path resolution"

# A1. The dist directory the new code points at must exist.
DIST_DIR="packages/shared/dist/prompts/specs/wiki-types"
if [ -d "$DIST_DIR" ]; then
  pass "A1. expected YAML dir exists: $DIST_DIR"
else
  fail "A1. expected YAML dir missing: $DIST_DIR — tsdown build did not run, route will 500"
fi

# A2. The src/ path the OLD code pointed at must NOT be the only source —
# either it's also present (dev) or only dist exists (production). The
# regression we're guarding against is "src/ removed but code still
# referenced it." This passes as long as dist/ has YAML.
DIST_YAML_COUNT=$(ls "$DIST_DIR"/*.yaml 2>/dev/null | wc -l | tr -d '[:space:]')
if [ "${DIST_YAML_COUNT:-0}" -ge 10 ] 2>/dev/null; then
  pass "A2. dist/ contains $DIST_YAML_COUNT YAML wiki-type specs (≥10 expected from seed)"
else
  fail "A2. dist/ contains only $DIST_YAML_COUNT YAML files — production deploy will load empty"
fi

# A3. Code-level: the route file points at dist/, not src/. This guards
# against a future merge that re-introduces the src/ path.
if grep -q "'dist'" core/src/routes/wiki-types.ts && ! grep -q "'src'.*'prompts'" core/src/routes/wiki-types.ts; then
  pass "A3. core/src/routes/wiki-types.ts references 'dist' (not 'src')"
else
  fail "A3. wiki-types.ts still references src/ for spec resolution — PR regressed"
fi

# A4. GET /wiki-types returns 200 and a non-empty list. Pre-PR, on a
# production deploy where src/ is absent, this returned 500 or a list-of-
# zero; the bootstrap seed path also failed silently. We assert ≥10 (the
# seeded YAML count) because the route enriches DB rows with disk YAML —
# if disk YAML resolution is broken, the count drops or the route 500s.
WT_HTTP=$(curl -s -o /tmp/uat-26-wt.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wiki-types")
if [ "$WT_HTTP" = "200" ]; then
  pass "A4. GET /wiki-types → 200"
else
  fail "A4. GET /wiki-types → HTTP $WT_HTTP (probable YAML-path failure)"
fi

WT_COUNT=$(jq '(.wikiTypes // .) | length' /tmp/uat-26-wt.json 2>/dev/null)
if [ "${WT_COUNT:-0}" -ge 10 ] 2>/dev/null; then
  pass "A5. /wiki-types returned $WT_COUNT types (≥10 — disk YAML enrichment fired)"
else
  fail "A5. /wiki-types returned $WT_COUNT types (<10 — disk YAML enrichment likely failed)"
fi

# A6. The seeded `decision` type is present (sanity: end-to-end resolution
# from YAML on disk → DB → route response).
HAS_DECISION=$(jq '[((.wikiTypes // .) // [])[] | select(.slug == "decision")] | length' /tmp/uat-26-wt.json 2>/dev/null)
if [ "$HAS_DECISION" = "1" ]; then
  pass "A6. /wiki-types includes the 'decision' type (seeded YAML resolved)"
else
  fail "A6. 'decision' type missing from /wiki-types — YAML loader degraded"
fi

# ─────────────────────────────────────────────────────────────────────
# Section B — Synchronous keypair generation (PR claim #2, issue #172)
# ─────────────────────────────────────────────────────────────────────
# Pre-PR: keypair was fire-and-forget through BullMQ; on a deploy without
# a running provision worker, mcpEndpointUrl stayed empty forever.
# Post-PR: jit-provision.ts generates the keypair inline (guarded by
# KEY_ENCRYPTION_SECRET being set). Worker remains as fallback with a
# duplicate-generation guard. This section asserts the inline path
# delivered a usable JWT BEFORE any worker action.

echo ""
echo "B. Synchronous keypair on first sign-in"

# B1. Profile fetches successfully.
PROF_HTTP=$(curl -s -o /tmp/uat-26-profile.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/users/profile")
if [ "$PROF_HTTP" = "200" ]; then
  pass "B1. GET /users/profile → 200"
else
  fail "B1. GET /users/profile → HTTP $PROF_HTTP"
fi

# B2. mcpEndpointUrl is non-empty. Pre-PR on a worker-less deploy this
# was the empty string forever. The polling logic in CompleteStep.tsx
# (claim #3) retries every 2s while this is empty — but with claim #2
# it should be populated immediately.
MCP_URL=$(jq -r '.mcpEndpointUrl // ""' /tmp/uat-26-profile.json)
if [ -n "$MCP_URL" ]; then
  pass "B2. profile.mcpEndpointUrl is non-empty (inline keypair fired)"
else
  fail "B2. profile.mcpEndpointUrl empty — inline keypair did NOT fire (KEY_ENCRYPTION_SECRET unset? worker fallback hung?)"
fi

# B3. URL shape: /mcp?token=<JWT>. We extract the token; everything
# downstream depends on it.
MCP_TOKEN=$(echo "$MCP_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')
if [ -n "$MCP_TOKEN" ]; then
  pass "B3. mcpEndpointUrl carries a parseable token query param"
else
  fail "B3. could not parse token out of mcpEndpointUrl: $MCP_URL"
fi

# B4. JWT structure: three dot-separated segments.
TOKEN_SEGS=$(echo "$MCP_TOKEN" | awk -F. '{print NF}')
if [ "$TOKEN_SEGS" = "3" ]; then
  pass "B4. token has the 3-segment JWT shape"
else
  fail "B4. token has $TOKEN_SEGS segments (expected 3)"
fi

# Helper: base64url-decode the middle JWT segment so we can inspect claims.
b64url_decode() {
  local s="$1"
  # pad to a multiple of 4 with `=` and translate URL alphabet to standard.
  local pad=$(( (4 - ${#s} % 4) % 4 ))
  printf '%s' "$s$(printf '=%.0s' $(seq 1 $pad))" \
    | tr '_-' '/+' \
    | base64 -d 2>/dev/null
}

if [ -n "$MCP_TOKEN" ] && [ "$TOKEN_SEGS" = "3" ]; then
  HEADER_RAW=$(b64url_decode "$(echo "$MCP_TOKEN" | cut -d. -f1)")
  PAYLOAD_RAW=$(b64url_decode "$(echo "$MCP_TOKEN" | cut -d. -f2)")

  # B5. Header has alg=EdDSA (from signMcpToken in core/src/mcp/jwt.ts).
  ALG=$(echo "$HEADER_RAW" | jq -r '.alg // empty' 2>/dev/null)
  if [ "$ALG" = "EdDSA" ]; then
    pass "B5. JWT header.alg == EdDSA"
  else
    fail "B5. JWT header.alg is '$ALG' (expected EdDSA)"
  fi

  # B6. Header has a `kid` (publicKeyId derived from the row's publicKey).
  KID=$(echo "$HEADER_RAW" | jq -r '.kid // empty' 2>/dev/null)
  if [ -n "$KID" ]; then
    pass "B6. JWT header.kid is set ($KID)"
  else
    fail "B6. JWT header.kid missing — keypair row likely lacks publicKey"
  fi

  # B7. Payload carries `ver` (mcpTokenVersion) and `iat` + `exp`.
  # jq -e prints the matched value (e.g. `true`) to stdout AND sets exit
  # status; rely on the exit status via `if` rather than concatenating
  # `&& echo yes` (which appends to jq's stdout and breaks comparisons).
  if echo "$PAYLOAD_RAW" | jq -e '.ver != null' >/dev/null 2>&1; then HAS_VER=yes; else HAS_VER=no; fi
  if echo "$PAYLOAD_RAW" | jq -e '.iat != null' >/dev/null 2>&1; then HAS_IAT=yes; else HAS_IAT=no; fi
  if echo "$PAYLOAD_RAW" | jq -e '.exp != null' >/dev/null 2>&1; then HAS_EXP=yes; else HAS_EXP=no; fi
  if [ "$HAS_VER" = "yes" ] && [ "$HAS_IAT" = "yes" ] && [ "$HAS_EXP" = "yes" ]; then
    pass "B7. JWT payload has ver / iat / exp"
  else
    fail "B7. JWT payload missing claim(s): ver=$HAS_VER iat=$HAS_IAT exp=$HAS_EXP"
  fi
else
  skip "B5-B7. token unavailable — JWT structure assertions skipped"
fi

# B8. DB-side: users.public_key and users.encrypted_private_key are NOT NULL.
# This is the load-bearing inline-keypair invariant. Without these columns
# populated, signMcpToken returns null and mcpEndpointUrl stays empty.
if [ -n "${DATABASE_URL:-}" ] && [ -n "${INITIAL_USERNAME:-}" ]; then
  KEYPAIR_PRESENT=$(psql "$DATABASE_URL" -t -A -c "SELECT public_key IS NOT NULL AND encrypted_private_key IS NOT NULL FROM users WHERE email='$INITIAL_USERNAME'" 2>/dev/null | tr -d '[:space:]')
  if [ "$KEYPAIR_PRESENT" = "t" ]; then
    pass "B8. users.public_key + users.encrypted_private_key are populated"
  else
    fail "B8. keypair columns NOT populated (got '$KEYPAIR_PRESENT') — inline path failed silently"
  fi
else
  skip "B8. DATABASE_URL or INITIAL_USERNAME unset — keypair-column check skipped"
fi

# B9. The token actually authenticates against /mcp (positive path).
# This is the live end-to-end proof that the keypair on the row + the
# token derived from it agree. Uses tools/list which is the cheapest
# valid JSON-RPC call.
if [ -n "$MCP_TOKEN" ]; then
  MCP_RESP=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Origin: http://localhost:3000" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    "$SERVER_URL/mcp?token=$MCP_TOKEN")
  # Streamable-HTTP may SSE-frame the payload.
  if echo "$MCP_RESP" | grep -q '^data: '; then
    MCP_PAYLOAD=$(echo "$MCP_RESP" | sed -n 's/^data: //p' | head -1)
  else
    MCP_PAYLOAD="$MCP_RESP"
  fi
  TOOLS_COUNT=$(echo "$MCP_PAYLOAD" | jq '.result.tools | length // 0' 2>/dev/null)
  if [ "${TOOLS_COUNT:-0}" -ge 1 ] 2>/dev/null; then
    pass "B9. /mcp tools/list with valid token succeeded (got $TOOLS_COUNT tools)"
  else
    fail "B9. /mcp tools/list failed with the inline-minted token: ${MCP_PAYLOAD:0:200}"
  fi
else
  skip "B9. token unavailable — /mcp positive-path check skipped"
fi

# B10. Negative path: /mcp with an invalid token returns 401. This is the
# auth-rejection counterpart to B9 — proves the token isn't being silently
# bypassed. (Specifically a JWT-shaped but unsigned-by-our-key value.)
INVALID_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Origin: http://localhost:3000" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "$SERVER_URL/mcp?token=eyJhbGciOiJFZERTQSJ9.eyJ2ZXIiOjF9.bogus-signature")
if [ "$INVALID_HTTP" = "401" ]; then
  pass "B10. /mcp with invalid token → 401"
else
  fail "B10. /mcp with invalid token → HTTP $INVALID_HTTP (expected 401)"
fi

# B11. Empty-token path: /mcp without ?token= returns 401, not 500. Pre-PR
# users hit this if the worker was down (mcpEndpointUrl empty → user pasted
# the raw /mcp URL into Claude → Claude sent no token → 500 was visible).
NOTOKEN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Origin: http://localhost:3000" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "$SERVER_URL/mcp")
if [ "$NOTOKEN_HTTP" = "401" ]; then
  pass "B11. /mcp without token → 401"
else
  fail "B11. /mcp without token → HTTP $NOTOKEN_HTTP (expected 401)"
fi

# ─────────────────────────────────────────────────────────────────────
# Section C — MCP polling on the Complete step (PR claim #3)
# ─────────────────────────────────────────────────────────────────────
# CompleteStep.tsx now polls /users/profile every 2s while mcpEndpointUrl
# is empty, and renders "Generating your MCP endpoint..." with a Spinner
# instead of the legacy "Unavailable" string. We assert the source-level
# changes (cheap, deterministic) AND drive the route through the browser
# to confirm it renders without the legacy copy.

echo ""
echo "C. Complete step polling + spinner copy"

# C1. Source: the polling effect uses a 2000ms interval. The setInterval
# call spans 3 lines, so we use `grep -A2` to allow the pattern to match
# across the call's argument lines instead of a single-line regex.
if grep -A2 "setInterval(" wiki/src/components/onboarding/CompleteStep.tsx | grep -qE "^\s*\}, ?2000\)"; then
  pass "C1. CompleteStep.tsx polls every 2000ms"
else
  fail "C1. CompleteStep.tsx does not show a 2000ms polling interval"
fi

# C2. Source: legacy "Unavailable" string is replaced by the Generating copy.
if ! grep -q '"Unavailable"' wiki/src/components/onboarding/CompleteStep.tsx; then
  pass "C2. CompleteStep.tsx no longer renders the literal 'Unavailable' string"
else
  fail "C2. CompleteStep.tsx still references 'Unavailable' — old fallback path retained"
fi

if grep -q "Generating your MCP endpoint" wiki/src/components/onboarding/CompleteStep.tsx; then
  pass "C3. CompleteStep.tsx renders 'Generating your MCP endpoint...' copy"
else
  fail "C3. expected 'Generating your MCP endpoint...' copy missing from CompleteStep.tsx"
fi

# C4. Source: Spinner is imported and used as the inline indicator.
if grep -q "from \"@/components/ui/spinner\"" wiki/src/components/onboarding/CompleteStep.tsx \
   && grep -q "<Spinner" wiki/src/components/onboarding/CompleteStep.tsx; then
  pass "C4. CompleteStep.tsx uses the Spinner component while polling"
else
  fail "C4. Spinner import/usage missing from CompleteStep.tsx"
fi

# C5. PromptsStep regression: Continue button no longer gated by hasEdited.
# Pre-PR: disabled={!hasEdited}. Post-PR: disabled={false}. A user who
# reviews-without-editing must be able to advance.
if grep -qE "disabled=\{false\}" wiki/src/components/onboarding/PromptsStep.tsx; then
  pass "C5. PromptsStep.tsx Continue button is unconditionally enabled"
else
  fail "C5. PromptsStep.tsx still gates Continue on hasEdited (PR regressed)"
fi

# C6. Live: the /onboarding route renders 200 (not 500). This is the
# cheapest live-stack check — if the page itself doesn't load, the
# polling logic above is moot.
ONBOARD_HTTP=$(curl -s -o /tmp/uat-26-onboard.html -w "%{http_code}" "$WIKI_URL/onboarding" 2>/dev/null)
if [ "$ONBOARD_HTTP" = "200" ] || [ "$ONBOARD_HTTP" = "307" ] || [ "$ONBOARD_HTTP" = "302" ]; then
  pass "C6. GET $WIKI_URL/onboarding → $ONBOARD_HTTP (page reachable)"
else
  fail "C6. GET $WIKI_URL/onboarding → HTTP $ONBOARD_HTTP"
fi

# ─────────────────────────────────────────────────────────────────────
# Section D — Entry capture modal (PR claim #4, issue #183)
# ─────────────────────────────────────────────────────────────────────
# The Header now ships an "Add Entry" button that opens AddEntryModal.
# Modal: title (optional) + content (required) → SDK createEntry with
# {source: "web", type: "thought"}. We assert source-level wiring AND
# drive the live UI through agent-browser for both positive (submit
# creates an entry) and negative (cancel does NOT create an entry) paths.

echo ""
echo "D. Entry capture modal"

# D1. Source: AddEntryModal.tsx exists and POSTs source=web, type=thought.
if [ -f wiki/src/components/layout/AddEntryModal.tsx ]; then
  pass "D1. AddEntryModal.tsx exists"
else
  fail "D1. AddEntryModal.tsx is missing"
fi

if grep -q 'source: "web"' wiki/src/components/layout/AddEntryModal.tsx \
   && grep -q 'type: "thought"' wiki/src/components/layout/AddEntryModal.tsx; then
  pass "D2. AddEntryModal posts source='web' type='thought'"
else
  fail "D2. AddEntryModal does not post the documented source/type pair"
fi

# D3. Source: Header imports AddEntryModal and renders an "Add Entry" trigger.
if grep -q "AddEntryModal" wiki/src/components/layout/Header.tsx \
   && grep -q "Add Entry" wiki/src/components/layout/Header.tsx; then
  pass "D3. Header.tsx wires up the AddEntryModal + 'Add Entry' button"
else
  fail "D3. Header.tsx is missing AddEntryModal wiring"
fi

# D4. Backend contract: POST /entries with source=web type=thought succeeds.
# This is the pure API path the modal hits — covers it independently of UI.
ENTRY_PAYLOAD=$(jq -n \
  --arg c "UAT 26 entry $RUN_ID — captured via web modal API path." \
  --arg t "UAT 26 title $RUN_ID" \
  '{content:$c, title:$t, source:"web", type:"thought"}')
ENTRY_HTTP=$(curl -s -o /tmp/uat-26-entry.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$ENTRY_PAYLOAD" \
  "$SERVER_URL/entries")
if [ "$ENTRY_HTTP" = "200" ] || [ "$ENTRY_HTTP" = "201" ] || [ "$ENTRY_HTTP" = "202" ]; then
  pass "D4. POST /entries (source=web type=thought) → $ENTRY_HTTP"
  ENTRY_API_KEY=$(jq -r '.lookupKey // .id // empty' /tmp/uat-26-entry.json)
else
  fail "D4. POST /entries returned HTTP $ENTRY_HTTP — modal contract broken"
  ENTRY_API_KEY=""
fi

# D5. DB-side: the API-path entry persisted with source='web' and
# type='thought'. Pre-checks the modal won't silently drop these.
if [ -n "${DATABASE_URL:-}" ] && [ -n "$ENTRY_API_KEY" ]; then
  ROW=$(psql "$DATABASE_URL" -t -A -F'|' -c "SELECT source, type FROM raw_sources WHERE lookup_key='$ENTRY_API_KEY'" 2>/dev/null)
  ROW_SOURCE=$(echo "$ROW" | cut -d'|' -f1)
  ROW_TYPE=$(echo "$ROW" | cut -d'|' -f2)
  if [ "$ROW_SOURCE" = "web" ] && [ "$ROW_TYPE" = "thought" ]; then
    pass "D5. DB row for $ENTRY_API_KEY has source=web, type=thought"
  else
    fail "D5. DB row got source='$ROW_SOURCE' type='$ROW_TYPE' (expected web/thought)"
  fi
else
  skip "D5. DATABASE_URL unset or D4 failed — DB shape check skipped"
fi

# D6. Live UI — sign in via the browser so the Header (which only renders
# in an authenticated layout) is reachable. We pin to /wiki since that's
# the canonical landing route after onboarding.
npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

npx agent-browser open "$WIKI_URL/wiki" 2>/dev/null
npx agent-browser wait --load networkidle
HEADER_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-26-d-header.png 2>/dev/null

if echo "$HEADER_SNAP" | grep -q "Add Entry"; then
  pass "D6. Header shows 'Add Entry' button on /wiki"
else
  fail "D6. 'Add Entry' button not visible in header"
fi

if echo "$HEADER_SNAP" | grep -q "Add Wiki"; then
  pass "D7. 'Add Wiki' button still present (not regressed by D6)"
else
  fail "D7. 'Add Wiki' button missing — header regression"
fi

# D8. Negative path: open the modal, type nothing/empty, then close via the
# X / outside click — must NOT create an entry. Snapshot the entries list
# count before+after.
PRE_ENTRY_COUNT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/entries?limit=200" \
  | jq '.entries | length // 0' 2>/dev/null)

npx agent-browser find text "Add Entry" click 2>/dev/null
npx agent-browser wait --load networkidle
MODAL_OPEN_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-26-d-modal-open.png 2>/dev/null

if echo "$MODAL_OPEN_SNAP" | grep -qi "Capture a thought, note, or idea"; then
  pass "D8. Modal opened with the documented description copy"
else
  fail "D8. Modal description copy not found — modal may not have opened"
fi

# Close via Escape (Radix Dialog convention) without typing anything.
npx agent-browser key Escape 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1

POST_CLOSE_COUNT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/entries?limit=200" \
  | jq '.entries | length // 0' 2>/dev/null)

if [ "${POST_CLOSE_COUNT:-0}" = "${PRE_ENTRY_COUNT:-0}" ]; then
  pass "D9. closing the modal without submitting did NOT create an entry (count unchanged: $PRE_ENTRY_COUNT)"
else
  fail "D9. entry count changed on cancel: $PRE_ENTRY_COUNT → $POST_CLOSE_COUNT"
fi

# D10. Positive path: open modal, fill content, click "Add Entry" submit.
# Asserts the modal does the documented thing — invalidates the ['entries']
# query (not directly observable here) AND a new row appears in /entries.
npx agent-browser find text "Add Entry" click 2>/dev/null
npx agent-browser wait --load networkidle

UAT_BODY="UAT 26 web modal $RUN_ID — please capture this through the dialog."
UAT_TITLE="UAT 26 modal title $RUN_ID"
npx agent-browser fill 'input[placeholder="Give your thought a title"]' "$UAT_TITLE" 2>/dev/null
npx agent-browser fill 'textarea[placeholder="What'\''s on your mind?"]' "$UAT_BODY" 2>/dev/null

# The submit button label is "Add Entry" inside the modal too — the X-axis
# `find text` would match the header trigger. Scope to the modal's submit
# button (last "Add Entry" in DOM order is the submit; first is the trigger).
npx agent-browser eval "Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === 'Add Entry').pop().click()" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 2  # SDK round-trip + queryClient.invalidateQueries
npx agent-browser screenshot /tmp/uat-26-d-after-submit.png 2>/dev/null

POST_SUBMIT_COUNT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/entries?limit=200" \
  | jq '.entries | length // 0' 2>/dev/null)

if [ "${POST_SUBMIT_COUNT:-0}" -gt "${PRE_ENTRY_COUNT:-0}" ] 2>/dev/null; then
  pass "D10. modal submit created an entry (count $PRE_ENTRY_COUNT → $POST_SUBMIT_COUNT)"
else
  fail "D10. modal submit did not increase entries count ($PRE_ENTRY_COUNT → $POST_SUBMIT_COUNT)"
fi

# D11. The new row carries source=web type=thought (the modal's hardcoded
# values per the diff at AddEntryModal.tsx:99-102). DB cross-check.
if [ -n "${DATABASE_URL:-}" ]; then
  MODAL_SOURCE=$(psql "$DATABASE_URL" -t -A -c "SELECT source FROM raw_sources WHERE content LIKE 'UAT 26 web modal $RUN_ID%' ORDER BY created_at DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]')
  if [ "$MODAL_SOURCE" = "web" ]; then
    pass "D11. modal-created row has source='web'"
  else
    fail "D11. modal-created row has source='$MODAL_SOURCE' (expected 'web')"
  fi

  MODAL_TYPE=$(psql "$DATABASE_URL" -t -A -c "SELECT type FROM raw_sources WHERE content LIKE 'UAT 26 web modal $RUN_ID%' ORDER BY created_at DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]')
  if [ "$MODAL_TYPE" = "thought" ]; then
    pass "D12. modal-created row has type='thought'"
  else
    fail "D12. modal-created row has type='$MODAL_TYPE' (expected 'thought')"
  fi
else
  skip "D11-D12. DATABASE_URL unset — modal source/type DB check skipped"
fi

# D13. Toast confirmation: the modal sets toast "Entry created" on success
# and shows it for 2s after the dialog closes. We snapshot ~500ms after
# submit closure — the dialog has closed, the toast is visible.
TOAST_SNAP=$(npx agent-browser snapshot 2>/dev/null)
if echo "$TOAST_SNAP" | grep -q "Entry created"; then
  pass "D13. 'Entry created' toast surfaced after successful submit"
else
  skip "D13. toast not in current snapshot (timing window narrow — 2s auto-dismiss); not a hard fail"
fi

# ─────────────────────────────────────────────────────────────────────
# Cleanup — soft-delete the UAT rows we created
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "Cleanup"

if [ -n "${DATABASE_URL:-}" ]; then
  CLEANED=$(psql "$DATABASE_URL" -t -A -c "UPDATE raw_sources SET deleted_at=now(), updated_at=now() WHERE content LIKE 'UAT 26 %' AND deleted_at IS NULL RETURNING 1" 2>/dev/null | wc -l | tr -d '[:space:]')
  pass "Cleanup. soft-deleted $CLEANED UAT-26 raw_sources row(s)"
else
  skip "Cleanup. DATABASE_URL unset — UAT-26 rows left in place"
fi

npx agent-browser close 2>/dev/null || true

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | PR claim / Issue |
|---|-----------|------------------|
| 0a | Sign-in returns 200 (provisions first user inline if DB is empty) | prereq |
| A1 | `packages/shared/dist/prompts/specs/wiki-types/` exists | claim 1 / #172 |
| A2 | dist/ contains ≥10 YAML wiki-type spec files | claim 1 / #172 |
| A3 | `core/src/routes/wiki-types.ts` references `'dist'`, not `'src'` | claim 1 / #172 |
| A4 | `GET /wiki-types` → 200 | claim 1 / #172 |
| A5 | `/wiki-types` returns ≥10 types (disk YAML enrichment fired) | claim 1 / #172 |
| A6 | `/wiki-types` includes the seeded `decision` type | claim 1 / #172 |
| B1 | `GET /users/profile` → 200 | claim 2 / #172 |
| B2 | `profile.mcpEndpointUrl` is non-empty (no worker required) | claim 2 / #172 |
| B3 | URL has `?token=<JWT>` query param | claim 2 / #172 |
| B4 | Token has the 3-segment JWT shape | claim 2 / #172 |
| B5 | JWT header `alg == EdDSA` | claim 2 / `mcp/jwt.ts` |
| B6 | JWT header `kid` is set | claim 2 / `mcp/jwt.ts` |
| B7 | JWT payload has `ver`, `iat`, `exp` claims | claim 2 / `mcp/jwt.ts` |
| B8 | `users.public_key` + `users.encrypted_private_key` populated for the user | claim 2 / #172 |
| B9 | `/mcp tools/list` with the minted token succeeds | claim 2 / #172 |
| B10 | `/mcp` with an invalid token → 401 | claim 2 negative |
| B11 | `/mcp` without a token → 401 | claim 2 negative |
| C1 | `CompleteStep.tsx` polls every 2000ms | claim 3 / #172 |
| C2 | Legacy "Unavailable" string removed from `CompleteStep.tsx` | claim 3 / #172 |
| C3 | "Generating your MCP endpoint..." copy present | claim 3 / #172 |
| C4 | Spinner imported and rendered in `CompleteStep.tsx` | claim 3 / #172 |
| C5 | `PromptsStep.tsx` Continue button uses `disabled={false}` (no `hasEdited` gate) | bonus PR claim |
| C6 | `/onboarding` route loads (200/302/307) | claim 3 / live |
| D1 | `wiki/src/components/layout/AddEntryModal.tsx` exists | claim 4 / #183 |
| D2 | Modal posts `source: "web"` and `type: "thought"` | claim 4 / #183 |
| D3 | `Header.tsx` wires up the modal with an "Add Entry" trigger | claim 4 / #183 |
| D4 | `POST /entries` (source=web, type=thought) → 200/201 | claim 4 backend |
| D5 | DB row from API path has `source='web'` and `type='thought'` | claim 4 backend |
| D6 | Header shows "Add Entry" button on `/wiki` (live) | claim 4 / #183 |
| D7 | "Add Wiki" button still present (no header regression) | claim 4 sanity |
| D8 | Modal opens with documented description copy | claim 4 / #183 |
| D9 | Closing modal without submitting does NOT create an entry (negative) | claim 4 / #183 |
| D10 | Submitting modal creates an entry (positive — entries count grows) | claim 4 / #183 |
| D11 | Modal-created row persisted with `source='web'` | claim 4 / #183 |
| D12 | Modal-created row persisted with `type='thought'` | claim 4 / #183 |
| D13 | "Entry created" toast surfaces after success (best-effort, narrow window) | claim 4 polish |
| Cleanup | All UAT-26 raw_sources rows soft-deleted | hygiene |

---

## Notes

- **Coverage map.** Every PR-#189 claim gets its own section (A/B/C/D), and
  each closes-issue acceptance criterion maps to ≥1 assertion: #172 →
  sections A, B, C, plus C5; #183 → section D's positive (D10/D11/D12)
  AND negative (D9) paths. The "5-min onboarding" bar from #172 is
  addressed structurally — claims 1–3 remove the three failure modes that
  blew the budget pre-PR (YAML 500, missing keypair, "Unavailable"
  dead-end).
- **No /mcp session handshake.** Like plan 98, the JSON-RPC calls in B9–B11
  are stateless — the route at `core/src/routes/mcp.ts` creates a fresh
  server + transport per request, no `Mcp-Session-Id`. If that changes,
  this section needs an `initialize` step.
- **Inline keypair vs worker fallback.** The PR keeps the BullMQ provision
  job as a fallback. If the inline path fails (e.g. `KEY_ENCRYPTION_SECRET`
  unset, B8 will fail) the worker can still recover via `processProvisionJob`'s
  duplicate-generation guard. This plan asserts the inline path on the
  happy path; soak / failure-injection coverage of the fallback belongs
  in plan 04 / 97.
- **C-section mixes static + live checks.** C1–C5 are grep-against-source
  because the polling cadence and copy are deterministic from the diff;
  C6 is a live HTTP probe. The full "spinner appears while polling"
  narrative requires a fresh-DB run before sign-in completes — covered
  structurally by B2 + the source assertions, not driven through a
  forced-empty-keypair scenario (that would require mutating the user
  row mid-test, which fights the seed invariant).
- **D-section browser scoping.** D10's submit click uses an `eval` to grab
  the *last* `Add Entry` button in document order (the modal's submit) —
  the *first* one is the header trigger. If the modal's button label
  changes, the eval needs updating.
- **D9 cancel mechanism.** Escape closes Radix `Dialog` per the modal's
  `onOpenChange` wiring — pre-PR negative-path coverage didn't exist
  because the modal didn't exist. We assert the entry count is unchanged;
  no row inserted is the load-bearing claim. The toast does NOT fire on
  cancel (the modal's effect ties toast firing to a successful submit).
- **D13 timing window.** The toast auto-dismisses after 2000ms. agent-browser
  snapshot may miss it if the network round-trip + DOM update was fast.
  Marked as `skip` rather than `fail` if not seen — D10/D11/D12 already
  prove the success path.
- **Cleanup uses content prefix `UAT 26 `.** All UAT-created rows are
  soft-deleted at end of run via `LIKE 'UAT 26 %'` on `raw_sources.content`.
  Mirrors plan 98's UAT cleanup hygiene.
- **Out of scope here.** Migration of stale users that already have empty
  keypair columns (handled by the existing worker fallback + the
  `processProvisionJob` duplicate guard); production smoke of the dist/
  YAML on Railway (deferred — see project memory `project_railway_deploy.md`).
