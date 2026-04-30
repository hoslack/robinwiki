-- Owner-Person concept (#238). The user account itself gets a Person row
-- marked as the owner so first-person pronouns ("I", "me", "my") in the
-- classifier prompt resolve to a real Person key via the new [AUTHORSHIP]
-- block, instead of the brittle pronoun-substitution rule the fragmenter
-- used to apply.
--
-- Single-tenant note: people already lives without user_id (M2 collapse).
-- A boolean flag plus a partial unique index keeps the invariant "at most
-- one owner" at the DB layer without re-introducing user_id.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS people_is_owner_uidx
  ON people ((is_owner))
  WHERE is_owner = true AND deleted_at IS NULL;
