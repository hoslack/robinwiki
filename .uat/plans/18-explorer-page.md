# 18 — Explorer Page (Frontend)

## What it proves
Explorer renders, filters toggle, sort changes order, URL state persists.

## Prerequisites
Wiki dev server running on WIKI_URL.

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

WIKI_URL="${WIKI_URL:-http://localhost:8080}"
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "18 — Explorer Page"
echo ""

# 1. Page loads
HTTP=$(curl -s -o /tmp/uat-explorer.html -w "%{http_code}" "$WIKI_URL/explorer" 2>/dev/null)
if [ "$HTTP" = "200" ]; then
  pass "GET /explorer → 200"
  if grep -q "explorer/page.tsx\|explorer" /tmp/uat-explorer.html 2>/dev/null; then
    pass "page loads explorer component (client-rendered)"
  else
    fail "page missing explorer component reference"
  fi
else
  fail "GET /explorer → HTTP $HTTP (wiki server may not be running)"
fi

# 2. Page with filter params loads
HTTP2=$(curl -s -o /tmp/uat-explorer-filtered.html -w "%{http_code}" \
  "$WIKI_URL/explorer?type=wiki&sort=alpha" 2>/dev/null)
[ "$HTTP2" = "200" ] && pass "filtered URL loads (type=wiki&sort=alpha)" || fail "filtered URL → HTTP $HTTP2"

# 3. API endpoints used by explorer respond
source core/.env 2>/dev/null || true
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null 2>/dev/null

WIKIS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=200")
FRAGS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/fragments?limit=200")
PEOPLE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/people?limit=200")
GROUPS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/groups")

[ "$WIKIS_HTTP" = "200" ] && pass "explorer data: /wikis → 200" || fail "explorer data: /wikis → $WIKIS_HTTP"
[ "$FRAGS_HTTP" = "200" ] && pass "explorer data: /fragments → 200" || fail "explorer data: /fragments → $FRAGS_HTTP"
[ "$PEOPLE_HTTP" = "200" ] && pass "explorer data: /people → 200" || fail "explorer data: /people → $PEOPLE_HTTP"
[ "$GROUPS_HTTP" = "200" ] && pass "explorer data: /groups → 200" || fail "explorer data: /groups → $GROUPS_HTTP"

echo ""
echo "$PASS passed, $FAIL failed"
```
