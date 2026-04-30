# 50 — Numbered superscript citations + document-wide numbering + lookupKey hrefs (#245)

## What it proves

The wiki body's per-section citation chips are upgraded to numbered
superscripts. Numbering is document-wide and sequential (each fragment
gets one stable number across the whole wiki, even if it backs multiple
sections). Each superscript is an in-page anchor to a citations section
at the bottom of the article: `<a href="#fragment-{lookupKey}">[N]</a>`.

The citations section lists every cited fragment by lookupKey with a
matching anchor target (`<li id="fragment-{lookupKey}">`). The list is
deduped by lookupKey and ordered by first appearance.

POSITIVE:
- `WikiCitations` superscripts emit `href="#fragment-{lookupKey}"`.
- A new `WikiCitationsSection` component renders the list with anchor
  ids matching the superscript targets.
- `SectionedMarkdownBody` threads a running offset across sections so
  numbering is document-wide (not per-section).
- `wiki/[id]/page.tsx` renders the citations section after the body.

NEGATIVE: pre-fix the superscripts link to `/fragments/{id}` (external
route), there is no `WikiCitationsSection` component, and per-section
numbering restarts at 1.

## Prerequisites

- core on `http://localhost:3000`, wiki on `http://localhost:8080`
- A wiki with at least one section that has citations (regen output)

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "50 — Numbered citations: doc-wide numbering + lookupKey hrefs (#245)"

CITES=wiki/src/components/wiki/WikiCitations.tsx
SECTION=wiki/src/components/wiki/WikiCitationsSection.tsx
SMB=wiki/src/app/\(shell\)/wiki/\[id\]/SectionedMarkdownBody.tsx
PAGE=wiki/src/app/\(shell\)/wiki/\[id\]/page.tsx

# ── A. Superscripts use #fragment-{lookupKey} hrefs ────────────────
if grep -qE '#fragment-' "$CITES" 2>/dev/null; then
  pass "A1. WikiCitations emits #fragment-{lookupKey} hrefs"
else
  fail "A1. WikiCitations does NOT emit in-page fragment anchors"
fi

# Negative: the old external-route href should no longer be the primary target
if grep -qE 'ROUTES\.fragment\(' "$CITES" 2>/dev/null; then
  fail "A2. WikiCitations still uses ROUTES.fragment() as the anchor target"
else
  pass "A2. WikiCitations no longer uses external route as anchor target"
fi

# ── B. Citations-section component exists ──────────────────────────
if [ -f "$SECTION" ]; then
  pass "B1. WikiCitationsSection component exists"
else
  fail "B1. WikiCitationsSection component missing"
fi

if grep -qE 'id=.fragment-' "$SECTION" 2>/dev/null; then
  pass "B2. WikiCitationsSection renders id=\"fragment-{lookupKey}\""
else
  fail "B2. WikiCitationsSection does not render in-page anchor ids"
fi

# ── C. Document-wide numbering wired ───────────────────────────────
if grep -qE 'startIndex|runningOffset|citationOffset|docOffset|numberFor' "$SMB" 2>/dev/null; then
  pass "C1. SectionedMarkdownBody passes a running offset to WikiCitations"
else
  fail "C1. SectionedMarkdownBody has no running offset — numbering still per-section"
fi

# Negative: pre-fix, the section body always renders <WikiCitations citations={citations} />
# without a startIndex prop. Post-fix, at least one call site should pass startIndex.
if grep -qE 'WikiCitations[^>]*startIndex' "$SMB" 2>/dev/null; then
  pass "C2. WikiCitations is invoked with explicit startIndex"
else
  fail "C2. WikiCitations is invoked without startIndex (per-section numbering)"
fi

# ── D. Page wires the citations section ────────────────────────────
if grep -qE 'WikiCitationsSection' "$PAGE" 2>/dev/null; then
  pass "D1. wiki/[id]/page.tsx renders <WikiCitationsSection>"
else
  fail "D1. wiki/[id]/page.tsx does NOT render <WikiCitationsSection>"
fi

# ── E. Type/build sanity ───────────────────────────────────────────
TSC_OUT=/tmp/uat50-tsc.txt
if npx --yes tsc --noEmit -p wiki/tsconfig.json > "$TSC_OUT" 2>&1; then
  pass "E1. wiki tsc clean"
else
  fail "E1. wiki tsc errors:"
  head -40 "$TSC_OUT"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
