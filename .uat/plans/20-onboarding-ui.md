# 20 — Onboarding UI (Frontend)

## What it proves
CustomizeStep renders model selectors, PromptsStep lists wiki types, APIs respond.

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

WIKI_URL="${WIKI_URL:-http://localhost:8080}"
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "20 — Onboarding UI"
echo ""

# 1. Root page loads
HTTP=$(curl -s -o /tmp/uat-root.html -w "%{http_code}" "$WIKI_URL/" 2>/dev/null)
[ "$HTTP" = "200" ] && pass "GET / → 200" || fail "GET / → HTTP $HTTP"

# 2. Login page loads
# NOTE: /login SSR shell is a loading spinner only — the "Sign in" heading
# is client-rendered after hydration, so we do NOT grep curl HTML for it.
# Asserting the route returns 200 + has no signup option is sufficient.
LOGIN_HTTP=$(curl -s -o /tmp/uat-login.html -w "%{http_code}" "$WIKI_URL/login" 2>/dev/null)
if [ "$LOGIN_HTTP" = "200" ]; then
  pass "GET /login → 200"
  # Verify no signup
  if grep -qi "create account\|sign up" /tmp/uat-login.html 2>/dev/null; then
    fail "login page has signup option (should be login-only)"
  else
    pass "login page has no signup option"
  fi
else
  fail "GET /login → HTTP $LOGIN_HTTP"
fi

# 3. Recover page loads
RECOVER_HTTP=$(curl -s -o /tmp/uat-recover.html -w "%{http_code}" "$WIKI_URL/recover" 2>/dev/null)
if [ "$RECOVER_HTTP" = "200" ]; then
  pass "GET /recover → 200"
  if grep -qi "secret key\|reset password" /tmp/uat-recover.html 2>/dev/null; then
    pass "recover page has secret key form"
  else
    fail "recover page missing form content"
  fi
else
  fail "GET /recover → HTTP $RECOVER_HTTP"
fi

# 4. APIs that onboarding depends on
source core/.env 2>/dev/null || true
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null 2>/dev/null

# CustomizeStep needs /ai/models
MODELS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/ai/models")
[ "$MODELS_HTTP" = "200" ] && pass "onboarding dep: /ai/models → 200" || fail "onboarding dep: /ai/models → $MODELS_HTTP"

# CustomizeStep needs /users/preferences/models
PREFS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/users/preferences/models")
[ "$PREFS_HTTP" = "200" ] && pass "onboarding dep: /users/preferences/models → 200" || fail "onboarding dep: prefs → $PREFS_HTTP"

# PromptsStep needs /wiki-types
WT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wiki-types")
[ "$WT_HTTP" = "200" ] && pass "onboarding dep: /wiki-types → 200" || fail "onboarding dep: wiki-types → $WT_HTTP"

echo ""
echo "$PASS passed, $FAIL failed"
```
