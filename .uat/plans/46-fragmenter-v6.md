# 46 — Fragmenter v6: topic-coherence + fluff filter (#242)

## What it proves

Issue #242 reframes the fragmenter prompt away from a *word-count target*
heuristic to a *topic-coherence + fluff-filter* heuristic. The current
prompt (`packages/shared/src/prompts/specs/fragmentation.yaml`, version 4)
contains a GRANULARITY rule that injects `{{wordCount}}` and
`{{fragmentTarget}}` and tells the LLM to "Aim for approximately N
fragments". The loader (`packages/shared/src/prompts/loaders/fragmentation.ts`)
computes those numbers from the entry length.

Post-fix, the prompt:
- Drops the word-count → fragment-count formula.
- States that each fragment is **one atomic idea** judged by topic
  coherence, not by length.
- Adds an explicit fluff filter: filler / preamble / signposting prose
  (e.g. "so", "anyway", "as I was saying", "let me explain") MUST NOT
  become fragments.
- Bumps `version` to 6 so cached spec consumers invalidate.

The runtime ceiling (`computeFragmentLimits().ceiling`) stays as a safety
net — that's a *code* cap, not a *prompt* nudge. The prompt no longer
suggests a target number.

## Negative + positive assertions

| § | Kind | Check |
|---|------|-------|
| 1a | NEG | `fragmentation.yaml` does NOT contain literal `wordCount` template variable |
| 1b | NEG | `fragmentation.yaml` does NOT contain literal `fragmentTarget` |
| 1c | NEG | `fragmentation.yaml` does NOT contain `Aim for approximately` |
| 1d | NEG | The phrase `word count` (case-insensitive) absent from the rules block |
| 2a | POS | `fragmentation.yaml` mentions `topic coherence` (or `coherence`) |
| 2b | POS | `fragmentation.yaml` mentions a `fluff` filter |
| 2c | POS | `fragmentation.yaml` mentions `atomic idea` |
| 3a | POS | `version: 6` set on the spec |
| 4a | POS | Loader (`loaders/fragmentation.ts`) no longer injects `wordCount` / `fragmentTarget` into the rendered template |

## Notes on AI-quality assertions skipped

A behavioural test ("real entry containing fluff prose now produces zero
fluff fragments") would require a live LLM call and a quality judgment.
The handover policy says: assert structural shape, not LLM prose
quality. The prompt-text greps above are the falsifiable proxy.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "46 — Fragmenter v6 (#242)"
echo ""

YAML="packages/shared/src/prompts/specs/fragmentation.yaml"
LOADER="packages/shared/src/prompts/loaders/fragmentation.ts"

if [ ! -f "$YAML" ]; then
  fail "0a. $YAML missing"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi
pass "0a. fragmenter yaml present"

# ── 1. Negative: word-count machinery removed ──────────────
if grep -q '{{wordCount}}' "$YAML"; then
  fail "1a. yaml still contains {{wordCount}} template variable"
else
  pass "1a. {{wordCount}} removed"
fi

if grep -q '{{fragmentTarget}}' "$YAML"; then
  fail "1b. yaml still contains {{fragmentTarget}} template variable"
else
  pass "1b. {{fragmentTarget}} removed"
fi

if grep -q 'Aim for approximately' "$YAML"; then
  fail "1c. yaml still says 'Aim for approximately'"
else
  pass "1c. 'Aim for approximately' phrase removed"
fi

# 'word count' anywhere in the rules block (case-insensitive)
if grep -qi 'word count' "$YAML"; then
  fail "1d. yaml still mentions 'word count'"
else
  pass "1d. 'word count' phrase absent"
fi

# ── 2. Positive: coherence + fluff + atomic idea ───────────
if grep -qi 'coherence' "$YAML"; then
  pass "2a. yaml mentions 'coherence'"
else
  fail "2a. yaml does not mention 'coherence'"
fi

if grep -qi 'fluff' "$YAML"; then
  pass "2b. yaml mentions 'fluff'"
else
  fail "2b. yaml does not mention 'fluff'"
fi

if grep -qi 'atomic idea' "$YAML"; then
  pass "2c. yaml mentions 'atomic idea'"
else
  fail "2c. yaml does not mention 'atomic idea'"
fi

# ── 3. Version bump ────────────────────────────────────────
if grep -qE '^version:\s*6\b' "$YAML"; then
  pass "3a. version: 6"
else
  CURRENT_VERSION=$(grep -E '^version:' "$YAML" | head -1)
  fail "3a. version is not 6 (saw: $CURRENT_VERSION)"
fi

# ── 4. Loader no longer injects wordCount / fragmentTarget into rendered template ──
if [ ! -f "$LOADER" ]; then
  skip "4a. loader file missing — cannot check"
else
  # The loader may still export computeFragmentLimits for code-side ceiling,
  # but it must NOT pass wordCount / fragmentTarget into renderTemplate.
  if grep -A 6 'renderTemplate' "$LOADER" | grep -qE 'wordCount|fragmentTarget'; then
    fail "4a. loader still injects wordCount/fragmentTarget into renderTemplate"
  else
    pass "4a. loader no longer injects wordCount/fragmentTarget into the prompt"
  fi
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
