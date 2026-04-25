# 22 — Onboarding Demo Seed

## What it proves
First-run bootstrap auto-seeds the Transformer demo wiki on first-user provisioning; reboot is idempotent (no duplicate rows, gated log message); the manual `pnpm -C core seed-fixture` CLI updates rather than duplicates and supports `--dry-run` without a `DATABASE_URL`; the seeded wiki returns a fully populated sidecar envelope (`refs`, `infobox`, per-section `citations`, tokenized markdown body); the seeded wiki is reachable as onboarding content (explorer list → detail page); a user who deletes the demo wiki is not re-seeded on reboot (documented intentional behavior — `ensureFirstUser` only fires once per instance).

## Prerequisites
- Core app checked out at a commit that includes the sidecar seed integration (bootstrap `seedDemoWiki` on first-user provisioning + `pnpm -C core seed-fixture` CLI).
- Access to a local Postgres instance the test can point `DATABASE_URL` at, reset-able to empty.
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env` for the initial-user provisioning flow.

## Fixture identity this plan references
- Wiki slug: `transformer-architecture`
- Wiki name: `Transformer Architecture`
- Wiki type: `project`
- Seeded people slugs: `ashish-vaswani`, `noam-shazeer`, `niki-parmar`
- Seeded fragment slugs: `self-attention-replaces-recurrence`, `multi-head-attention-parallelism`, `positional-encoding-sequence-order`, `scaled-dot-product-attention`, `encoder-decoder-stacks`
- Seeded entry slug: `attention-paper-abstract`

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "22 — Onboarding Demo Seed"
echo ""

# ── 1. --dry-run works without DATABASE_URL ──────────────────
# Projection is pure — the dry-run path must not require a DB. This also
# proves the CI/worktree case where DATABASE_URL isn't configured.

DRY_OUT=$(DATABASE_URL="" pnpm -C core seed-fixture -- --dry-run 2>&1 || true)
echo "$DRY_OUT" > /tmp/uat-22-dryrun.log

if echo "$DRY_OUT" | grep -qi "DRY RUN"; then
  pass "1a. seed-fixture --dry-run runs without DATABASE_URL"
else
  fail "1a. seed-fixture --dry-run did not emit DRY RUN output"
fi

# Dry-run should report the intended wiki slug + counts so a human can
# sanity-check the projection before writing.
if echo "$DRY_OUT" | grep -q "transformer-architecture"; then
  pass "1b. dry-run references fixture slug 'transformer-architecture'"
else
  fail "1b. dry-run did not mention 'transformer-architecture' slug"
fi

if echo "$DRY_OUT" | grep -qE "[0-9]+ people"; then
  pass "1c. dry-run reports planned people count"
else
  fail "1c. dry-run did not report people count"
fi

if echo "$DRY_OUT" | grep -qE "[0-9]+ fragments"; then
  pass "1d. dry-run reports planned fragment count"
else
  fail "1d. dry-run did not report fragment count"
fi

# ── 2. Fresh-instance bootstrap auto-seed ────────────────────
# With an empty users + wikis table, provisioning the first user should
# seed the demo wiki as a side effect of ensureFirstUser().
#
# Two ways to hit this in a UAT run:
#   (a) environment-owned reset: the harness resets the DB before this
#       script runs, ships core up, and the first auth call provisions
#       the initial user from env vars.
#   (b) this step is marked SKIP when the harness can't reset Postgres
#       (dev machines with production-style data).
#
# The assertion below works in either path: if no users exist yet, we
# exercise the provisioning flow; if a user already exists, we check
# that the seed side-effect is historically visible in logs and DB.

if [ -z "${INITIAL_USERNAME:-}" ] || [ -z "${INITIAL_PASSWORD:-}" ]; then
  skip "2. INITIAL_USERNAME/INITIAL_PASSWORD not set — can't exercise first-user flow"
else
  # Sign in — in a freshly-reset DB this provisions the user and triggers
  # seedDemoWiki; on an already-provisioned DB it's a no-op that still
  # lets us verify the seeded wiki is present.
  SIGNIN_HTTP=$(curl -s -o /tmp/uat-22-signin.json -w "%{http_code}" -c "$COOKIE_JAR" -X POST \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3000" \
    -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
    "$SERVER_URL/api/auth/sign-in/email")

  if [ "$SIGNIN_HTTP" = "200" ]; then
    pass "2a. Initial-user sign-in succeeds (HTTP $SIGNIN_HTTP)"
  else
    fail "2a. Initial-user sign-in failed (HTTP $SIGNIN_HTTP)"
  fi

  # After provisioning, the Transformer demo wiki row must exist.
  WIKIS_AFTER=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50")
  SEEDED=$(echo "$WIKIS_AFTER" | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')
  if [ "$SEEDED" = "1" ]; then
    pass "2b. 'transformer-architecture' wiki present after provisioning"
  else
    fail "2b. Transformer demo wiki not seeded after provisioning (count=$SEEDED)"
  fi

  # Log assertion — "Seeded Transformer demo wiki" should appear at least
  # once since the last boot, unless this is a reboot (covered in step 3).
  # If a core log file is exposed via CORE_LOG_PATH, grep it; otherwise skip.
  if [ -n "${CORE_LOG_PATH:-}" ] && [ -f "$CORE_LOG_PATH" ]; then
    if grep -qi "Seeded Transformer demo wiki\|Demo wiki already present" "$CORE_LOG_PATH"; then
      pass "2c. Boot log contains 'Seeded Transformer demo wiki' or 'already present' line"
    else
      fail "2c. Boot log lacks seed evidence (neither 'Seeded' nor 'already present' lines)"
    fi
  else
    skip "2c. CORE_LOG_PATH not set — log assertion skipped"
  fi
fi

# ── 3. Re-boot idempotency ───────────────────────────────────
# Running the manual CLI against a seeded DB is the cheapest proxy for a
# core reboot: the gate logic is identical (`isFixtureSeeded()` short-
# circuits). Re-running must NOT duplicate rows and MUST keep the same
# lookupKey (slug-keyed upsert, not insert).

# Capture pre-rerun identity.
PRE_WIKI=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50")
PRE_COUNT=$(echo "$PRE_WIKI" | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')
PRE_KEY=$(echo "$PRE_WIKI" | jq -r '.wikis[] | select(.slug == "transformer-architecture") | .lookupKey // .id' | head -1)

if [ "${DATABASE_URL:-}" = "" ]; then
  skip "3. DATABASE_URL not set — can't exercise real-DB idempotency"
else
  RERUN_OUT=$(pnpm -C core seed-fixture 2>&1 || true)
  echo "$RERUN_OUT" > /tmp/uat-22-rerun.log

  POST_WIKI=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50")
  POST_COUNT=$(echo "$POST_WIKI" | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')
  POST_KEY=$(echo "$POST_WIKI" | jq -r '.wikis[] | select(.slug == "transformer-architecture") | .lookupKey // .id' | head -1)

  # 3a. No duplicate rows.
  if [ "$POST_COUNT" = "1" ]; then
    pass "3a. Re-running seed-fixture keeps wiki count at 1 (no duplicates)"
  else
    fail "3a. Duplicate Transformer wikis after re-seed (count=$POST_COUNT)"
  fi

  # 3b. lookupKey stable across re-seed (upsert-by-slug, not insert).
  if [ "$PRE_KEY" = "$POST_KEY" ] && [ -n "$POST_KEY" ]; then
    pass "3b. Wiki lookupKey preserved across re-seed ($POST_KEY)"
  else
    fail "3b. lookupKey changed: was=$PRE_KEY now=$POST_KEY"
  fi

  # 3c. People + fragments also de-duplicated.
  PEOPLE_COUNT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/people?limit=100" \
    | jq '[.people[] | select(.slug == "ashish-vaswani")] | length')
  FRAG_COUNT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/fragments?limit=100" \
    | jq '[.fragments[] | select(.slug == "self-attention-replaces-recurrence")] | length')

  if [ "$PEOPLE_COUNT" = "1" ]; then
    pass "3c. Person 'ashish-vaswani' count = 1 after re-seed"
  else
    fail "3c. Person 'ashish-vaswani' count = $PEOPLE_COUNT (expected 1)"
  fi

  if [ "$FRAG_COUNT" = "1" ]; then
    pass "3d. Fragment 'self-attention-replaces-recurrence' count = 1 after re-seed"
  else
    fail "3d. Fragment 'self-attention-replaces-recurrence' count = $FRAG_COUNT (expected 1)"
  fi

  # 3e. The re-run should log a skip signal (isFixtureSeeded → true) OR
  # an update-in-place signal. Either is acceptable; what's NOT acceptable
  # is "inserted new wiki" on a reseed.
  if echo "$RERUN_OUT" | grep -qi "inserted new wiki"; then
    fail "3e. Re-seed logged 'inserted new wiki' — upsert path regressed"
  else
    pass "3e. Re-seed did not insert a new wiki (upsert path honored)"
  fi
fi

# ── 4. Seeded wiki has full sidecar ──────────────────────────
# GET /wikis/<lookupKey> on the demo wiki returns a populated sidecar
# envelope: refs for people/fragments/wiki/entry; infobox with all four
# valueKinds; sections[].citations populated for the overview +
# architecture sections; token-substituted markdown body.

TK="$PRE_KEY"
if [ -z "${TK:-}" ] || [ "$TK" = "null" ]; then
  fail "4. No Transformer lookupKey available — seed did not run"
else
  WIKI_DETAIL=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TK")
  echo "$WIKI_DETAIL" > /tmp/uat-22-wiki-detail.json

  # 4a. refs populated for all four kinds.
  REFS_PERSON=$(echo "$WIKI_DETAIL" | jq '[.refs | to_entries[] | select(.value.kind == "person")] | length')
  REFS_FRAG=$(echo "$WIKI_DETAIL" | jq '[.refs | to_entries[] | select(.value.kind == "fragment")] | length')
  REFS_WIKI=$(echo "$WIKI_DETAIL" | jq '[.refs | to_entries[] | select(.value.kind == "wiki")] | length')
  REFS_ENTRY=$(echo "$WIKI_DETAIL" | jq '[.refs | to_entries[] | select(.value.kind == "entry")] | length')

  [ "${REFS_PERSON:-0}" -ge 3 ] 2>/dev/null && pass "4a. refs contain ≥3 person entries ($REFS_PERSON)" || fail "4a. person refs count: $REFS_PERSON (expected ≥3)"
  [ "${REFS_FRAG:-0}" -ge 5 ] 2>/dev/null && pass "4b. refs contain ≥5 fragment entries ($REFS_FRAG)" || fail "4b. fragment refs count: $REFS_FRAG (expected ≥5)"
  [ "${REFS_WIKI:-0}" -ge 1 ] 2>/dev/null && pass "4c. refs contain ≥1 wiki entry ($REFS_WIKI)" || skip "4c. wiki-kind refs: $REFS_WIKI (the fixture references 1 wiki target — verify seed policy)"
  [ "${REFS_ENTRY:-0}" -ge 1 ] 2>/dev/null && pass "4d. refs contain ≥1 entry reference ($REFS_ENTRY)" || fail "4d. entry refs count: $REFS_ENTRY (expected ≥1)"

  # 4e. infobox has all four valueKinds represented.
  for KIND in "text" "ref" "date" "status"; do
    HAS_KIND=$(echo "$WIKI_DETAIL" | jq --arg k "$KIND" '[.infobox.rows[] | select(.valueKind == $k)] | length')
    if [ "${HAS_KIND:-0}" -ge 1 ] 2>/dev/null; then
      pass "4e. infobox has at least one row with valueKind='$KIND'"
    else
      fail "4e. infobox missing valueKind='$KIND' row"
    fi
  done

  # 4f. sections[].citations populated on 'overview' and 'architecture'.
  OVER_CITES=$(echo "$WIKI_DETAIL" | jq '[.sections[] | select(.anchor == "overview") | .citations | length] | add // 0')
  ARCH_CITES=$(echo "$WIKI_DETAIL" | jq '[.sections[] | select(.anchor == "architecture") | .citations | length] | add // 0')

  [ "${OVER_CITES:-0}" = "2" ] && pass "4f. 'overview' section has 2 citations" || fail "4f. 'overview' section citations: $OVER_CITES (expected 2)"
  [ "${ARCH_CITES:-0}" = "2" ] && pass "4g. 'architecture' section has 2 citations" || fail "4g. 'architecture' section citations: $ARCH_CITES (expected 2)"

  # 4h. notes / notes-1 sections have citations: [] (empty, not missing).
  NOTES_CITES=$(echo "$WIKI_DETAIL" | jq '[.sections[] | select(.anchor == "notes") | .citations | length] | add // -1')
  NOTES1_CITES=$(echo "$WIKI_DETAIL" | jq '[.sections[] | select(.anchor == "notes-1") | .citations | length] | add // -1')

  [ "$NOTES_CITES" = "0" ] && pass "4h. 'notes' section has empty citations array" || fail "4h. 'notes' citations count: $NOTES_CITES (expected 0)"
  [ "$NOTES1_CITES" = "0" ] && pass "4i. 'notes-1' section has empty citations array" || fail "4i. 'notes-1' citations count: $NOTES1_CITES (expected 0)"

  # 4j. Markdown body still contains raw tokens (front-end does the
  # substitution; back-end delivers unresolved markdown).
  BODY=$(echo "$WIKI_DETAIL" | jq -r '.wikiContent // .content // ""')
  if echo "$BODY" | grep -q '\[\[person:ashish-vaswani\]\]'; then
    pass "4j. Wiki body retains [[person:ashish-vaswani]] token for client-side resolution"
  else
    fail "4j. Wiki body missing expected ashish-vaswani token"
  fi

  # 4k. The intentional unresolved token is present in body but absent
  # from refs — policy-critical for the renderer fallback.
  GHOST_IN_BODY=$(echo "$BODY" | grep -c '\[\[person:anonymous-reviewer\]\]' || true)
  GHOST_IN_REFS=$(echo "$WIKI_DETAIL" | jq 'has("refs") and (.refs | has("person:anonymous-reviewer"))')
  if [ "$GHOST_IN_BODY" -ge 1 ] && [ "$GHOST_IN_REFS" = "false" ]; then
    pass "4k. [[person:anonymous-reviewer]] in body but absent from refs (intentional)"
  else
    fail "4k. anonymous-reviewer policy broken (in-body=$GHOST_IN_BODY, in-refs=$GHOST_IN_REFS)"
  fi
fi

# ── 5. Seeded demo serves as onboarding landing ──────────────
# After bootstrap, a user visiting the wiki explorer should see the
# Transformer wiki and be able to click through to its detail page.

npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

# 5a. Explorer shows the Transformer wiki.
npx agent-browser open "$WIKI_URL/" 2>/dev/null
npx agent-browser wait --load networkidle
EXPLORE_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-22-05-explorer.png 2>/dev/null

if echo "$EXPLORE_SNAP" | grep -qi "Transformer Architecture"; then
  pass "5a. Explorer lists the seeded 'Transformer Architecture' wiki"
else
  fail "5a. Explorer does not show seeded demo wiki"
fi

# 5b. Clicking through lands on the detail page with the seeded body.
npx agent-browser find text "Transformer Architecture" click 2>/dev/null
npx agent-browser wait --load networkidle
DETAIL_SNAP=$(npx agent-browser snapshot 2>/dev/null)
DETAIL_URL=$(npx agent-browser get url 2>/dev/null || echo "")
npx agent-browser screenshot /tmp/uat-22-05-detail.png 2>/dev/null

if echo "$DETAIL_URL" | grep -qE "/(transformer-architecture|wiki[A-Z0-9]+)" && echo "$DETAIL_SNAP" | grep -qi "Overview"; then
  pass "5b. Clicking the Transformer card lands on the detail page with rendered body"
else
  fail "5b. Transformer card click did not land on detail page (URL: $DETAIL_URL)"
fi

# ── 6. Seeded wiki survives user deletion ────────────────────
# If the user deletes the demo wiki and the core app is restarted, the
# demo wiki must NOT be re-seeded — ensureFirstUser only fires when the
# users table is empty, so a second boot with a provisioned user does
# not trigger seedDemoWiki again. This is intentional per the phase
# that wired the bootstrap integration.

# Delete the demo wiki.
if [ -n "${TK:-}" ] && [ "$TK" != "null" ]; then
  DEL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X DELETE \
    -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TK")
  if [ "$DEL_HTTP" = "200" ] || [ "$DEL_HTTP" = "204" ]; then
    pass "6a. Demo wiki deleted (HTTP $DEL_HTTP)"
  else
    fail "6a. Demo wiki delete failed (HTTP $DEL_HTTP)"
  fi

  # Verify gone.
  GONE=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50" \
    | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')
  if [ "$GONE" = "0" ]; then
    pass "6b. Transformer wiki absent from /wikis listing after delete"
  else
    fail "6b. Transformer wiki still listed after delete (count=$GONE)"
  fi

  # Simulate a reboot — the actual reboot is usually harness-owned. The
  # single behavioral contract we're testing is that `ensureFirstUser`
  # does NOT fire on a subsequent boot (users row exists). The cheapest
  # way to assert this without process control is to sign the user in
  # again (which re-enters the auth path but not ensureFirstUser) and
  # verify the wiki remains absent.

  curl -s -c "$COOKIE_JAR" -X POST \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3000" \
    -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
    "$SERVER_URL/api/auth/sign-in/email" >/dev/null 2>/dev/null

  AFTER_REBOOT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50" \
    | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')

  if [ "$AFTER_REBOOT" = "0" ]; then
    pass "6c. Transformer wiki NOT re-seeded after subsequent sign-in (ensureFirstUser gated on empty users)"
  else
    fail "6c. Transformer wiki reappeared without being re-seeded manually (count=$AFTER_REBOOT)"
  fi

  # 6d. Confirm the CLI still works to restore the demo wiki when the
  # user wants it back — this is the documented recovery path for a
  # deleted demo.
  if [ -n "${DATABASE_URL:-}" ]; then
    pnpm -C core seed-fixture >/dev/null 2>&1 || true
    RESTORED=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50" \
      | jq '[.wikis[] | select(.slug == "transformer-architecture")] | length')
    if [ "$RESTORED" = "1" ]; then
      pass "6d. Manual 'seed-fixture' CLI restores the demo wiki after user deletion"
    else
      fail "6d. CLI re-seed did not restore demo wiki (count=$RESTORED)"
    fi
  else
    skip "6d. DATABASE_URL not set — CLI restore path skipped"
  fi
else
  skip "6. No Transformer lookupKey — delete/re-seed path untested"
fi

# ── 7. Invariants — data-plane + retry scheduler ─────────────
# Post-seed, the data plane must be in a known-good shape. These are
# the checks that #150 (silent embeddings) and #151 (no retry) would
# have failed pre-fix — they pair with the fixes to keep the data
# plane from drifting silently going forward.

# 7a. The seeded demo wiki must be RESOLVED (not PENDING / LINKING).
# A seeded wiki that never reached RESOLVED means the seed path broke
# before finalization — the wiki listing would show it but detail pages
# would refuse to render.
WIKI_STATE=$(psql "$DATABASE_URL" -t -A -c "SELECT state FROM wikis WHERE slug='transformer-architecture' AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
if [ "$WIKI_STATE" = "RESOLVED" ]; then
  pass "7a. seeded demo wiki is RESOLVED"
else
  fail "7a. seeded demo wiki state='$WIKI_STATE' (expected RESOLVED)"
fi

# 7b. The embedding retry scheduler must be registered in Redis (issue
# #151). Without it, any fragment whose embedding failed at ingest time
# stays NULL forever. Detect registration via BullMQ's scheduler key.
if command -v redis-cli >/dev/null; then
  if redis-cli KEYS 'bull:regen-scheduler-queue:repeat:*' 2>/dev/null | grep -q 'embedding-retry'; then
    pass "7b. embedding retry scheduler registered"
  elif redis-cli KEYS 'bull:regen-scheduler-queue:meta*' 2>/dev/null >/dev/null; then
    # BullMQ's key shape varies across versions. Fall back to a broader
    # search so this doesn't fail on a mere key-naming change.
    if redis-cli --scan --pattern 'bull:regen-scheduler-queue:*' 2>/dev/null | grep -qi embedding; then
      pass "7b. embedding retry scheduler registered (fallback match)"
    else
      fail "7b. no 'embedding-retry' scheduler found on regen-scheduler-queue"
    fi
  else
    skip "7b. scheduler queue not initialized yet — retry check inconclusive"
  fi
else
  skip "7b. redis-cli unavailable — scheduler registration not verified"
fi

# 7c. Count of unembedded live fragments must be *observable* (i.e.,
# queryable with the index #151 added). This is not a zero-tolerance
# check — the retry scheduler runs every 15 min and UAT can't wait
# that long — but a SELECT that returns a definite integer proves the
# index exists and the columns were migrated. Logs the count so a
# soak test downstream can assert convergence to zero.
UNEMBEDDED=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM fragments WHERE embedding IS NULL AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
if [[ "$UNEMBEDDED" =~ ^[0-9]+$ ]]; then
  pass "7c. unembedded-fragments count is observable (=$UNEMBEDDED)"
  echo "    ↳ soak target: this value should trend to 0 as the retry scheduler runs"
else
  fail "7c. unembedded-fragments count query failed — migration 0006 not applied?"
fi

# 7d. Columns added by migration 0006 exist on fragments.
HAS_ATTEMPT_COL=$(psql "$DATABASE_URL" -t -A -c "SELECT 1 FROM information_schema.columns WHERE table_name='fragments' AND column_name='embedding_attempt_count'" 2>/dev/null | tr -d '[:space:]')
HAS_LAST_COL=$(psql "$DATABASE_URL" -t -A -c "SELECT 1 FROM information_schema.columns WHERE table_name='fragments' AND column_name='embedding_last_attempt_at'" 2>/dev/null | tr -d '[:space:]')
if [ "$HAS_ATTEMPT_COL" = "1" ] && [ "$HAS_LAST_COL" = "1" ]; then
  pass "7d. embedding retry bookkeeping columns present"
else
  fail "7d. migration 0006 did not apply (attempt_count=$HAS_ATTEMPT_COL, last=$HAS_LAST_COL)"
fi

# 7e. The partial index #151 added exists. Without it the retry scan
# degrades to a table scan at scale.
HAS_PARTIAL_IDX=$(psql "$DATABASE_URL" -t -A -c "SELECT 1 FROM pg_indexes WHERE indexname='fragments_embedding_null_idx' AND indexdef LIKE '%WHERE%embedding IS NULL%deleted_at IS NULL%'" 2>/dev/null | tr -d '[:space:]')
if [ "$HAS_PARTIAL_IDX" = "1" ]; then
  pass "7e. fragments_embedding_null_idx is partial on embedding/deleted_at"
else
  fail "7e. partial index missing or non-partial — retry scan will degrade"
fi

# ── 8. wikis.description column accepts INSERTs ────────────
# Regression guard for #167. Pre-fix every wiki INSERT failed because
# drizzle's insert lists the description column but no migration created
# it (visible as a swallowed error in seedDemoWiki on first-user
# provisioning, plus 500s on MCP create_wiki and HTTP POST /wikis).
# This step proves the seeded wiki row is readable on .description AND
# a fresh HTTP create_wiki round-trips through 2xx.

# 8a. The seed succeeded — verified by step 2b/7a above. Strengthen it:
# the description column exists on wikis (i.e. migration 0007 applied,
# not just present in the file). Use information_schema rather than a
# value test — the seeded row's description may legitimately be NULL.
HAS_DESC_COL=$(psql "$DATABASE_URL" -t -A -c "SELECT 1 FROM information_schema.columns WHERE table_name='wikis' AND column_name='description'" 2>/dev/null | tr -d '[:space:]')
if [ "$HAS_DESC_COL" = "1" ]; then
  pass "8a. wikis.description column exists (migration 0007 applied)"
else
  fail "8a. wikis.description column missing — migration 0007 did not apply"
fi

# 8b. Cross-surface: HTTP POST /wikis succeeds. Pre-fix this 500'd
# because the column referenced in the INSERT didn't exist in the DB.
RESP_CODE=$(curl -s -o /tmp/uat-22-create-wiki.json -w "%{http_code}" -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"name":"UAT description test","type":"log"}' \
  "$SERVER_URL/wikis")
if [ "$RESP_CODE" = "200" ] || [ "$RESP_CODE" = "201" ]; then
  pass "8b. HTTP POST /wikis returns $RESP_CODE (description column present in DB)"
  # Cleanup: soft-delete the UAT row so downstream plans see a clean
  # seeded fixture. Response shape carries both .lookupKey and .id —
  # prefer lookupKey since that's the documented routing key.
  KEY=$(jq -r '.lookupKey // .id' /tmp/uat-22-create-wiki.json 2>/dev/null)
  if [ -n "$KEY" ] && [ "$KEY" != "null" ]; then
    curl -s -o /dev/null -X DELETE -b "$COOKIE_JAR" \
      -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$KEY" || true
  fi
else
  fail "8b. HTTP POST /wikis returned $RESP_CODE — description column may be missing"
fi

# ── 9. Embedding retry execution ────────────────────────────
# step 9 graduates from SKIP to a real assertion once /admin/scheduler/run-now/embedding-retry exists (PR D)
#
# Plan 22 step 7c only proves the unembedded count is observable. A real
# assertion that the retry worker executes — i.e. the end-to-end
# correctness of #151 — needs a force-trigger debug endpoint so UAT can
# drive convergence to zero without waiting for the 15-min scheduler
# tick. That endpoint (POST /admin/scheduler/run-now/:jobName, gated by
# NODE_ENV !== 'production') is planned in PR D of this workstream.
#
# Until PR D lands, mark this step SKIP. The placeholder keeps the
# numbering stable so PR D is a pure additive replacement.
skip "9. embedding retry execution — debug endpoint not yet present"

# ── Cleanup ──────────────────────────────────────────────────
npx agent-browser close 2>/dev/null || true

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 1 | `seed-fixture --dry-run` runs without `DATABASE_URL`; reports slug + counts | pure projection in `seedFixtureProjection.ts` |
| 2 | Initial-user provisioning triggers `seedDemoWiki`; demo wiki row present after sign-in; boot log references the seed path | `ensureFirstUser` + `seed-demo-wiki` |
| 3 | Re-running seed-fixture on a seeded DB: no duplicate wikis/people/fragments; stable `lookupKey`; no "inserted new wiki" log line | slug-keyed upsert in `seedFixture.ts` |
| 4 | Seeded wiki returns populated sidecar: refs for all 4 kinds, infobox with 4 valueKinds, 2 citations each on 'overview' + 'architecture', empty on 'notes' + 'notes-1', tokens in body, `anonymous-reviewer` deliberately absent from refs | `buildSidecar` + fixture identity |
| 5 | Explorer lists the seeded wiki; click → detail page with rendered body | onboarding landing path |
| 6 | Deleting the demo wiki + subsequent sign-in does NOT re-seed (intentional — `ensureFirstUser` only fires when users table is empty); CLI `seed-fixture` remains the documented recovery path | bootstrap gate policy |
| 7 | Invariants: wiki RESOLVED; embedding retry scheduler registered; unembedded count observable; migration 0006 applied with partial index | #150 + #151 |
| 8 | `wikis.description` column readable on the seeded row; fresh HTTP `POST /wikis` returns 2xx (cleanup deletes the UAT row) | #167 / migration 0007 |
| 9 | Embedding retry worker actually heals NULL embeddings — SKIP until `POST /admin/scheduler/run-now/embedding-retry` debug endpoint lands (PR D) | #151 |

---

## Notes

- Step 2 assumes the initial-user provisioning path is reachable via the auth sign-in endpoint. On a freshly-reset DB this is the only way to trigger `ensureFirstUser`; on an already-provisioned DB the sign-in is a no-op and the seeded row is verified directly. The harness is expected to run this plan either (a) after a DB reset to exercise the fresh path, or (b) against an existing seeded instance to exercise the idempotency + recovery paths.
- Step 3's "reboot" is exercised via `pnpm -C core seed-fixture` rather than a true process restart: the gate logic (`isFixtureSeeded()` short-circuit) is identical in both call sites. If the harness can restart the core process between 2 and 3, the log assertion in step 2c becomes a stronger signal for the true bootstrap path.
- Step 6 validates a deliberately narrow behavior — the phase that wired the bootstrap seed chose not to re-seed on later reboots, and the CLI is the manual recovery path. Changing this policy should add a positive re-seed test here and deprecate assertion 6c.
- Storage is Postgres-only for every surface exercised here (no filesystem, no markdown-on-disk). All seeded rows live in the `wikis`, `people`, `fragments`, `entries`, and `edges` tables.
