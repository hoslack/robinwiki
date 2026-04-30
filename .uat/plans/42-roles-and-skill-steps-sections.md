# 42 — `## Roles` + `## The Skill, Step by Step` sections (#248)

## What it proves

Two surgical additions to wiki-type default_structure fields:

1. **project.yaml** — `default_structure` declares a `## Roles`
   section between Status and Progress (or anywhere — assertion is
   presence + position).
2. **skill.yaml** — `default_structure` declares a
   `## The Skill, Step by Step` section.

Stacks on #244 (default_structure must already exist).

## Prerequisites

- `default_structure` field present on every yaml (#244).

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

echo "42 — Roles + Skill steps sections (#248)"

YAML_DIR=packages/shared/src/prompts/specs/wiki-types

# Extract the default_structure block (everything between
# `default_structure: |` and the next top-level YAML key).
extract_default_structure() {
  awk '/^default_structure: \|$/{f=1;next} /^[a-zA-Z_]+:/{f=0} f' "$1"
}

# ── A. POSITIVE — project.yaml has ## Roles in default_structure ──
PROJECT_DS=$(extract_default_structure "$YAML_DIR/project.yaml")
if echo "$PROJECT_DS" | grep -qE '^\s*## Roles\b'; then
  pass "A1. project.yaml default_structure declares '## Roles'"
else
  fail "A1. project.yaml default_structure is MISSING '## Roles'"
fi

# ── A2. POSITIVE — skill.yaml has ## The Skill, Step by Step in default_structure ──
SKILL_DS=$(extract_default_structure "$YAML_DIR/skill.yaml")
if echo "$SKILL_DS" | grep -qE '^\s*## The Skill, Step by Step\b'; then
  pass "A2. skill.yaml default_structure declares '## The Skill, Step by Step'"
else
  fail "A2. skill.yaml default_structure is MISSING '## The Skill, Step by Step'"
fi

# ── A3. POSITIVE — heading ordering: project Roles appears AFTER Status ──
if awk '/## Status/{s=1} s && /## Roles/{print "ok"; exit}' "$YAML_DIR/project.yaml" | grep -q ok; then
  pass "A3. project.yaml '## Roles' appears AFTER '## Status'"
else
  fail "A3. project.yaml '## Roles' does NOT appear after '## Status'"
fi

# ── A4. POSITIVE — skill steps appear AFTER Core Techniques ──
if awk '/## Core Techniques/{s=1} s && /## The Skill, Step by Step/{print "ok"; exit}' "$YAML_DIR/skill.yaml" | grep -q ok; then
  pass "A4. skill.yaml steps section appears AFTER '## Core Techniques'"
else
  fail "A4. skill.yaml steps section does NOT appear after '## Core Techniques'"
fi

# ── B. NEGATIVE — sections do NOT appear in template body (must live in default_structure) ──
PROJECT_BODY=$(awk '/^template: \|$/{f=1;next} /^input_variables:/{f=0} f' "$YAML_DIR/project.yaml")
if echo "$PROJECT_BODY" | grep -qE '^\s*## Roles\b'; then
  fail "B1. project.yaml template body STILL contains '## Roles' (should only live in default_structure)"
else
  pass "B1. project.yaml template body has no inline '## Roles'"
fi

SKILL_BODY=$(awk '/^template: \|$/{f=1;next} /^input_variables:/{f=0} f' "$YAML_DIR/skill.yaml")
if echo "$SKILL_BODY" | grep -qE '^\s*## The Skill, Step by Step\b'; then
  fail "B2. skill.yaml template body STILL contains '## The Skill, Step by Step'"
else
  pass "B2. skill.yaml template body has no inline '## The Skill, Step by Step'"
fi

# ── B3. NEGATIVE — other yamls DON'T grow these sections by accident ──
for slug in agent belief collection decision log objective principles voice; do
  if grep -qE '## Roles\b|## The Skill, Step by Step' "$YAML_DIR/$slug.yaml"; then
    fail "B3.$slug yaml unexpectedly grew a Roles or Steps heading"
  else
    pass "B3.$slug yaml is unaffected (no Roles/Steps)"
  fi
done

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
```
