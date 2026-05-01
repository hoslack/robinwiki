-- Add embedding-retry bookkeeping columns to wikis + people, mirroring fragments.
-- Generalises the retry worker (was fragments-only) to all three embeddable tables.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so fresh installs that already received
-- these columns via a future bootstrap update don't double-error.

ALTER TABLE wikis
  ADD COLUMN IF NOT EXISTS embedding_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedding_last_attempt_at timestamp;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS embedding_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedding_last_attempt_at timestamp;
