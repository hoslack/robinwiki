-- Catch-up migration for fragments_dedup_hash_idx (issue #210). The index
-- is declared in core/src/db/schema.ts but no migration ever shipped, so
-- findDuplicateFragment falls back to a sequential scan on the live DB.
--
-- Made partial on `deleted_at IS NULL` because dedup lookups always
-- filter soft-deleted rows out — the partial form keeps the index small
-- and matches the existing fragments_embedding_null_idx convention.
DROP INDEX IF EXISTS "fragments_dedup_hash_idx";--> statement-breakpoint
CREATE INDEX "fragments_dedup_hash_idx" ON "fragments" USING btree ("dedup_hash") WHERE "fragments"."deleted_at" IS NULL;
