# 82, Regen partition headers and [USER EDITS] block drop

## What it proves

Stream R closes the gap between v0.2.0 E1 partition logic in
`core/src/lib/regen.ts` and the wiki-type Quill prompts in
`packages/shared/src/prompts/specs/wiki-types/`. Three pieces ship
together:

1. A contract test at `core/src/lib/regen.partition.test.ts`
   captures the Quill prompt and asserts it carries the partition
   headers (`[NEW FRAGMENTS`, `[UPDATED FRAGMENTS`, `[REMOVED
   FRAGMENTS`) without leaking a flat `[FRAGMENTS]` wrapper or a
   legacy `[USER EDITS]` block.
2. The legacy `[USER EDITS]` block is removed from all ten
   wiki-type YAMLs (agent, belief, decision, log, objective,
   principle, project, research, skill, voice). Phyl flagged the
   block as dead context in v0.2.0 review, fragment-edit history
   already feeds the UPDATED partition the worker emits.
3. The `[FRAGMENTS]` wrapper line above `{{fragments}}` is dropped
   from every wiki-type YAML so the partition headers Quill sees
   match the keystone partition shape exactly. Inline references to
   `[FRAGMENTS]` in the slug rule and the citations rule are
   updated to point at "fragment inputs" instead, since there is
   no longer a `[FRAGMENTS]` header to anchor them.

Every wiki-type spec bumps version 3 to 4 so cached overrides
re-fetch the disk default.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a | POS | All ten wiki-type yamls are at `version: 4` |
| 1b | NEG | No yaml under `wiki-types/` contains `[USER EDITS` |
| 1c | NEG | No yaml under `wiki-types/` contains a `[FRAGMENTS]` line on its own |
| 1d | NEG | No yaml under `wiki-types/` declares `name: edits` in input_variables |
| 1e | POS | Each wiki-type yaml still substitutes `{{fragments}}` |
| 2a | POS | regen.ts emits `[NEW FRAGMENTS` header for the NEW partition |
| 2b | POS | regen.ts emits `[UPDATED FRAGMENTS` header for the UPDATED partition |
| 2c | POS | regen.ts emits `[REMOVED FRAGMENTS` header for the REMOVED partition |
| 3a | POS | Contract test file `core/src/lib/regen.partition.test.ts` exists |
| 3b | POS | Vitest runs the contract test green |
| 3c | POS | The full `pnpm -C core test regen` suite is green |
| 4a | POS | All wiki-type yamls parse via `yaml.safe_load` |

## AI-quality assertions (manual, behavioural)

These cannot be greppable, they require a running stack with a
real OpenRouter key. Track manually after deploy:

- Boot the core stack and the wiki UI. Pick a wiki with at least
  one prior regen so `last_rebuilt_at` is populated.
- Attach a fresh fragment so the NEW partition is non-empty, edit
  one existing fragment so the UPDATED partition is non-empty,
  detach one existing fragment so the REMOVED partition is
  non-empty.
- Trigger regen via the wiki "regen now" control or by waiting on
  the scheduler. Capture the prompt sent to Quill via the
  prompt-logging telemetry, or by tailing `core` stdout if the
  prompt-logging shim is enabled in dev.
- Confirm the captured user prompt contains all three partition
  headers, contains no `[USER EDITS` substring, and contains no
  `[FRAGMENTS]` line on its own.
- Repeat the trigger on each of the ten wiki types (one wiki per
  type). Confirm every type regenerates without an LLM error.
- Spot-read the regenerated body for one Belief, one Project, and
  one Log wiki. Quality should track v0.2.0 baseline (no missing
  sections, citations still emit, infobox still emits when
  applicable).

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip $1"; }

echo "82, Regen partition headers and [USER EDITS] block drop"
echo ""

YAML_DIR="packages/shared/src/prompts/specs/wiki-types"
REGEN_TS="core/src/lib/regen.ts"
TEST_FILE="core/src/lib/regen.partition.test.ts"

WIKI_TYPES=(agent belief decision log objective principle project research skill voice)

if [ ! -d "$YAML_DIR" ]; then
  fail "0a. $YAML_DIR missing"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi
pass "0a. wiki-types yaml dir present"

# 1. Per-yaml content checks
for wt in "${WIKI_TYPES[@]}"; do
  YAML="$YAML_DIR/$wt.yaml"
  if [ ! -f "$YAML" ]; then
    fail "1.$wt yaml missing"
    continue
  fi

  if grep -qE '^version:\s*4\b' "$YAML"; then
    pass "1a.$wt version: 4"
  else
    CURRENT=$(grep -E '^version:' "$YAML" | head -1)
    fail "1a.$wt version is not 4 (saw: $CURRENT)"
  fi

  if grep -q '\[USER EDITS' "$YAML"; then
    fail "1b.$wt still contains [USER EDITS"
  else
    pass "1b.$wt no [USER EDITS"
  fi

  if grep -qE '^\s*\[FRAGMENTS\]\s*$' "$YAML"; then
    fail "1c.$wt still has standalone [FRAGMENTS] header"
  else
    pass "1c.$wt no standalone [FRAGMENTS] header"
  fi

  # input_variables: name: edits should be gone
  if grep -qE '^\s*-\s*name:\s*edits\b' "$YAML"; then
    fail "1d.$wt still declares input_variable name: edits"
  else
    pass "1d.$wt no edits input_variable"
  fi

  if grep -q '{{fragments}}' "$YAML"; then
    pass "1e.$wt template still substitutes {{fragments}}"
  else
    fail "1e.$wt template missing {{fragments}} substitution"
  fi
done

# 2. regen.ts emits the new partition headers
if [ ! -f "$REGEN_TS" ]; then
  fail "2.0 $REGEN_TS missing"
else
  if grep -q '\[NEW FRAGMENTS' "$REGEN_TS"; then
    pass "2a. regen.ts emits [NEW FRAGMENTS header"
  else
    fail "2a. regen.ts missing [NEW FRAGMENTS header"
  fi

  if grep -q '\[UPDATED FRAGMENTS' "$REGEN_TS"; then
    pass "2b. regen.ts emits [UPDATED FRAGMENTS header"
  else
    fail "2b. regen.ts missing [UPDATED FRAGMENTS header"
  fi

  if grep -q '\[REMOVED FRAGMENTS' "$REGEN_TS"; then
    pass "2c. regen.ts emits [REMOVED FRAGMENTS header"
  else
    fail "2c. regen.ts missing [REMOVED FRAGMENTS header"
  fi
fi

# 3. Contract test exists and runs
if [ ! -f "$TEST_FILE" ]; then
  fail "3a. $TEST_FILE missing"
else
  pass "3a. partition contract test file present"

  if pnpm -C core test regen.partition --reporter=basic >/tmp/uat-82-partition.log 2>&1; then
    pass "3b. partition contract test green"
  else
    fail "3b. partition contract test red (see /tmp/uat-82-partition.log)"
  fi

  if pnpm -C core test regen --reporter=basic >/tmp/uat-82-regen.log 2>&1; then
    pass "3c. full regen test suite green"
  else
    fail "3c. full regen test suite red (see /tmp/uat-82-regen.log)"
  fi
fi

# 4. YAML parse
for wt in "${WIKI_TYPES[@]}"; do
  YAML="$YAML_DIR/$wt.yaml"
  [ -f "$YAML" ] || continue
  if python3 -c "import yaml,sys; yaml.safe_load(open('$YAML'))" 2>/dev/null; then
    pass "4a.$wt yaml parses"
  else
    fail "4a.$wt yaml does not parse"
  fi
done

# Cleanup: remove temporary log files. Tests left no DB or queue state behind.
rm -f /tmp/uat-82-partition.log /tmp/uat-82-regen.log

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
