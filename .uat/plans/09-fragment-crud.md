# 09 — Fragment CRUD

## What it proves
Fragment create, list, get, update, content-hash dedup.

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
DB_URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/robinwiki}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

RUN_SUFFIX="${UAT_RUN_ID:-$$}"
FRAG_CONTENT="Unique content for dedup test [$RUN_SUFFIX]"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "09 — Fragment CRUD"
echo ""

# Sign in
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null

# Need an entry for entryId — create one
ENTRY=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"content":"UAT fragment test entry"}' \
  "$SERVER_URL/entries")
ENTRY_ID=$(echo "$ENTRY" | jq -r '.id // .lookupKey // ""')

# 1. Create fragment
CREATE=$(curl -s -w "\n%{http_code}" -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"title\":\"UAT Test Fragment\",\"content\":\"$FRAG_CONTENT\",\"entryId\":\"$ENTRY_ID\",\"tags\":[\"uat\",\"test\"]}" \
  "$SERVER_URL/fragments")
CREATE_HTTP=$(echo "$CREATE" | tail -1)
CREATE_BODY=$(echo "$CREATE" | sed '$d')
FRAG_ID=$(echo "$CREATE_BODY" | jq -r '.lookupKey // .id // ""')

[ "$CREATE_HTTP" = "201" ] && pass "POST /fragments → 201, id=$FRAG_ID" || fail "POST /fragments → HTTP $CREATE_HTTP"

# 2. List
LIST_HTTP=$(curl -s -o /tmp/uat-frags.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments")
[ "$LIST_HTTP" = "200" ] && pass "GET /fragments → 200" || fail "GET /fragments → HTTP $LIST_HTTP"

# 3. Get detail
DETAIL_HTTP=$(curl -s -o /tmp/uat-frag-detail.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_ID")
if [ "$DETAIL_HTTP" = "200" ]; then
  HAS_CONTENT=$(jq 'has("content")' /tmp/uat-frag-detail.json 2>/dev/null)
  CONTENT_LEN=$(jq -r '.content | length' /tmp/uat-frag-detail.json 2>/dev/null || echo 0)
  HAS_TAGS=$(jq 'has("tags")' /tmp/uat-frag-detail.json 2>/dev/null)
  TAGS_LEN=$(jq -r '.tags | length' /tmp/uat-frag-detail.json 2>/dev/null || echo 0)
  [ "$HAS_CONTENT" = "true" ] && pass "detail has content field" || fail "detail missing content field"
  [ "$CONTENT_LEN" -gt 0 ] 2>/dev/null && pass "content is non-empty ($CONTENT_LEN chars)" || fail "content is empty (length=$CONTENT_LEN)"
  [ "$HAS_TAGS" = "true" ] && pass "detail has tags" || fail "detail missing tags"
  [ "$TAGS_LEN" -gt 0 ] 2>/dev/null && pass "tags is non-empty ($TAGS_LEN items)" || fail "tags is empty"
else
  fail "GET /fragments/:id → HTTP $DETAIL_HTTP"
fi

# 4. Update
UPDATE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"title":"UAT Fragment Updated","tags":["uat","updated"]}' \
  "$SERVER_URL/fragments/$FRAG_ID")
[ "$UPDATE_HTTP" = "200" ] && pass "PUT /fragments/:id → 200" || fail "PUT → HTTP $UPDATE_HTTP"

# Verify update
UPDATED_TITLE=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_ID" | jq -r '.title')
[ "$UPDATED_TITLE" = "UAT Fragment Updated" ] && pass "title updated" || fail "title: $UPDATED_TITLE"

# 5. Dedup — re-POST same original content (before any updates)
DEDUP=$(curl -s -w "\n%{http_code}" -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"title\":\"Duplicate\",\"content\":\"$FRAG_CONTENT\",\"entryId\":\"$ENTRY_ID\"}" \
  "$SERVER_URL/fragments")
DEDUP_HTTP=$(echo "$DEDUP" | tail -1)
[ "$DEDUP_HTTP" = "200" ] && pass "dedup returns 200 (not 201)" || fail "dedup returned $DEDUP_HTTP (expected 200)"

# 6. Content round-trip (#263) — PUT new content, GET, assert returned content matches.
# Bug present: PUT /fragments/:id writes dedupHash but never updates the
# `content` column, so the new body silently disappears. Frontend save
# loops round-trip the same broken endpoint.
# This step runs AFTER dedup (#5) because mutating content rotates the
# fragment's dedupHash and would invalidate the dedup probe.
NEW_FRAG_CONTENT="UAT-09 §6 new content body [$RUN_SUFFIX]"
PUT_CONTENT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$NEW_FRAG_CONTENT" '{content:$c}')" \
  "$SERVER_URL/fragments/$FRAG_ID")
[ "$PUT_CONTENT_HTTP" = "200" ] && pass "PUT /fragments/:id with {content} → 200" \
                                || fail "PUT content → HTTP $PUT_CONTENT_HTTP"

ROUNDTRIP_CONTENT=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_ID" | jq -r '.content')
if [ "$ROUNDTRIP_CONTENT" = "$NEW_FRAG_CONTENT" ]; then
  pass "6. content round-trip — PUT then GET returns the new content"
else
  fail "6. content round-trip — got '${ROUNDTRIP_CONTENT:0:60}', want '${NEW_FRAG_CONTENT:0:60}' (#263 — PUT writes dedupHash, never content)"
fi

echo ""
echo "$PASS passed, $FAIL failed"
```
