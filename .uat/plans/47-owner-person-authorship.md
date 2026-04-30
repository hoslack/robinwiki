# 47 — Owner-Person + classifier `[AUTHORSHIP]` block (#238)

## What it proves

Issue #238 fixes a brittle authorship resolution: the fragmenter used to
substitute "I/me/my" with the literal string "Author" so each fragment
read in third person. That breaks down on text with multiple speakers
(e.g. "Sarah said 'I should refactor'") and quietly mangles voice in
the database.

The new shape:

1. **Schema**: `people` gets an `is_owner` boolean column (migration
   `0011_people_is_owner.sql`) plus a partial unique index ensuring at
   most one row carries `is_owner = true` while live (`deleted_at IS
   NULL`). Single-tenant intent preserved — no `user_id` on the people
   table.
2. **Provisioning**: `ensureOwnerPerson()` in
   `core/src/bootstrap/jit-provision.ts` seeds an owner-Person row for
   the single user account on first sign-up. Idempotent — re-running on
   an existing owner returns the existing row.
3. **Classifier prompt**: `wiki-classification.yaml` (version: 3) gains
   an explicit `[AUTHORSHIP]` block that names the owner and tells the
   agent to interpret first-person pronouns as the owner unless an
   inline attribution like `"Sarah said 'I should…'"` makes another
   speaker explicit.
4. **Loader / stage wiring**: `loadWikiClassificationSpec` accepts a
   new `ownerName` arg and falls back to the literal "the owner" when
   absent so the prompt still renders. `WikiClassifyDeps.loadOwnerName`
   is wired into the BullMQ link job in `core/src/queue/worker.ts`.
5. **Fragmenter**: rule 10 (PRONOUNS) **stops substituting** I/me/my.
   The old "Replace … with Author" instruction is gone. Authorship is
   resolved downstream via the classifier's [AUTHORSHIP] block.

## Negative + positive assertions

| § | Kind | Check |
|---|------|-------|
| 1a | POS  | Migration `0011_people_is_owner.sql` exists |
| 1b | POS  | Migration mentions `is_owner` and a partial unique index |
| 1c | POS  | `core/src/db/schema.ts` declares `isOwner` on `people` |
| 1d | POS  | `_journal.json` includes the `0011_people_is_owner` entry |
| 2a | NEG  | Fragmenter prompt no longer says `Replace … with "Author"` |
| 2b | NEG  | Fragmenter prompt does NOT contain a substitution rule for I/me/my |
| 2c | POS  | Fragmenter prompt rule 10 instructs to LEAVE first-person pronouns as-is |
| 3a | POS  | `wiki-classification.yaml` contains `[AUTHORSHIP]` |
| 3b | POS  | `wiki-classification.yaml` references `{{ownerName}}` |
| 3c | POS  | `wiki-classification.yaml` is version: 3 |
| 4a | POS  | Loader `wiki-classification.ts` accepts `ownerName` |
| 4b | POS  | Worker provides `loadOwnerName` in wikiClassifyDeps |
| 5a | POS  | `jit-provision.ts` exports `ensureOwnerPerson` |
| 5b | POS  | `ensureOwnerPerson` writes `is_owner: true` |

## Notes on AI-quality assertions skipped

- A true behavioural test ("classifier correctly attributes 'I went for
  a run' to the owner-Person and 'Sarah said I should refactor' to
  Sarah") would require a live LLM call and a quality judgment. Per
  handover policy, prompt-text greps are the falsifiable proxy.
- An end-to-end test ("real ingest produces fragments with literal
  'I' / 'me' / 'my' instead of 'Author'") would require booting the
  worker stack and running a fixture entry. This is asserted
  structurally via §2 (the prompt-text rule change).

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

echo "47 — Owner-Person + classifier [AUTHORSHIP] block (#238)"
echo ""

MIG="core/drizzle/migrations/0011_people_is_owner.sql"
SCHEMA="core/src/db/schema.ts"
JOURNAL="core/drizzle/migrations/meta/_journal.json"
FRAG_YAML="packages/shared/src/prompts/specs/fragmentation.yaml"
WC_YAML="packages/shared/src/prompts/specs/wiki-classification.yaml"
WC_LOADER="packages/shared/src/prompts/loaders/wiki-classification.ts"
WORKER="core/src/queue/worker.ts"
PROV="core/src/bootstrap/jit-provision.ts"

# ── 1. Schema + migration shape ──────────────────────────────
if [ -f "$MIG" ]; then
  pass "1a. migration $MIG present"
else
  fail "1a. migration $MIG missing"
fi

if grep -q 'is_owner' "$MIG" && grep -qi 'unique.*index\|UNIQUE INDEX' "$MIG"; then
  pass "1b. migration declares is_owner + partial unique index"
else
  fail "1b. migration shape incomplete"
fi

if grep -q "isOwner" "$SCHEMA"; then
  pass "1c. schema.ts declares isOwner on people"
else
  fail "1c. schema.ts missing isOwner"
fi

if grep -q "0011_people_is_owner" "$JOURNAL"; then
  pass "1d. _journal.json contains 0011_people_is_owner"
else
  fail "1d. _journal.json missing 0011 entry"
fi

# ── 2. Fragmenter no longer substitutes pronouns ────────────
if grep -qE 'Replace .*Author' "$FRAG_YAML"; then
  fail "2a. fragmenter still says 'Replace … with \"Author\"'"
else
  pass "2a. fragmenter no longer substitutes I/me/my with 'Author'"
fi

# Generic: any pronoun-substitution language?
if grep -qiE 'replace .*(first.?person|pronoun|I.* me.* my|i, me, my)' "$FRAG_YAML"; then
  fail "2b. fragmenter still has a pronoun-substitution rule"
else
  pass "2b. fragmenter has no pronoun-substitution rule"
fi

# Positive: the rule must say leave them as-is.
if grep -qiE 'leave .*(first.?person|pronoun)' "$FRAG_YAML" && \
   grep -qi 'AUTHORSHIP' "$FRAG_YAML"; then
  pass "2c. fragmenter rule says leave first-person as-is, defer to AUTHORSHIP"
else
  fail "2c. fragmenter rule missing 'leave as-is' or AUTHORSHIP reference"
fi

# ── 3. Classifier yaml has [AUTHORSHIP] block ────────────────
if grep -q '\[AUTHORSHIP\]' "$WC_YAML"; then
  pass "3a. wiki-classification.yaml contains [AUTHORSHIP]"
else
  fail "3a. wiki-classification.yaml missing [AUTHORSHIP]"
fi

if grep -q '{{ownerName}}' "$WC_YAML"; then
  pass "3b. wiki-classification.yaml references {{ownerName}}"
else
  fail "3b. wiki-classification.yaml missing {{ownerName}}"
fi

if grep -qE '^version:\s*3\b' "$WC_YAML"; then
  pass "3c. wiki-classification.yaml is version: 3"
else
  CV=$(grep -E '^version:' "$WC_YAML" | head -1)
  fail "3c. wiki-classification.yaml not version 3 (saw: $CV)"
fi

# ── 4. Loader + worker wiring ────────────────────────────────
if grep -q 'ownerName' "$WC_LOADER"; then
  pass "4a. wiki-classification loader accepts ownerName"
else
  fail "4a. wiki-classification loader does not accept ownerName"
fi

if grep -q 'loadOwnerName' "$WORKER"; then
  pass "4b. worker.ts wires loadOwnerName into wikiClassifyDeps"
else
  fail "4b. worker.ts missing loadOwnerName"
fi

# ── 5. Provisioning seeds the owner-Person ───────────────────
if grep -q 'ensureOwnerPerson' "$PROV"; then
  pass "5a. jit-provision.ts exports ensureOwnerPerson"
else
  fail "5a. ensureOwnerPerson absent from jit-provision.ts"
fi

# Tighter shape: the seed sets is_owner = true. The function body
# spans ~60 lines (lookup + insert + return), so grep with a generous
# window so the assertion isn't sensitive to small style edits.
if grep -A 60 'export async function ensureOwnerPerson' "$PROV" \
     | grep -qE 'isOwner:\s*true'; then
  pass "5b. ensureOwnerPerson writes isOwner: true"
else
  fail "5b. ensureOwnerPerson does not set isOwner: true"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
