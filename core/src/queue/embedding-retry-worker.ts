import type { EmbeddingRetryJob, JobResult } from '@robin/queue'
import { and, isNull, lt, or, sql } from 'drizzle-orm'
import { embedText, takeLastEmbedFailure } from '@robin/agent'
import { db } from '../db/client.js'
import { fragments } from '../db/schema.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'embedding-retry' })

/** Max fragments to retry per tick. 15-min cron × 25 rows = 100/hour ceiling. */
const BATCH_LIMIT = 25

/** Attempt cap per fragment. Past this, the row is skipped until manual ops. */
const MAX_ATTEMPTS = 5

/** Minimum gap between retries of the same row, to avoid tick-level hammering. */
const MIN_RETRY_GAP_MS = 60 * 60 * 1000 // 1 hour

/**
 * Scheduler-driven retry of fragments whose embedding column is still NULL
 * (likely because the original ingest hit an OpenRouter failure). Bounded:
 * - BATCH_LIMIT rows per tick
 * - MAX_ATTEMPTS attempts per row, tracked via fragments.embedding_attempt_count
 * - MIN_RETRY_GAP_MS between successive attempts on the same row
 *
 * Pairs with the boot-time reachability probe (issue #150) — if the probe
 * refuses to start workers, this never runs; if it allows workers to start,
 * this worker opportunistically heals rows that failed at ingest time.
 */
export async function processEmbeddingRetryJob(
  job: EmbeddingRetryJob
): Promise<JobResult> {
  log.info({ jobId: job.jobId }, 'processing embedding retry batch')
  const t0 = performance.now()

  let config: Awaited<ReturnType<typeof loadOpenRouterConfig>> | undefined
  try {
    config = await loadOpenRouterConfig()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ jobId: job.jobId, error: message }, 'openrouter config unavailable — skipping batch')
    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  }

  const now = new Date()
  const cutoff = new Date(now.getTime() - MIN_RETRY_GAP_MS)

  // SELECT eligible rows: unembedded, not tombstoned, attempt count below cap,
  // and either never attempted or last attempt older than the gap. Ordered so
  // never-attempted rows (NULL last_attempt_at) go first.
  const rows = await db
    .select({
      lookupKey: fragments.lookupKey,
      content: fragments.content,
      attemptCount: fragments.embeddingAttemptCount,
    })
    .from(fragments)
    .where(
      and(
        isNull(fragments.embedding),
        isNull(fragments.deletedAt),
        lt(fragments.embeddingAttemptCount, MAX_ATTEMPTS),
        or(
          isNull(fragments.embeddingLastAttemptAt),
          lt(fragments.embeddingLastAttemptAt, cutoff)
        )
      )
    )
    .orderBy(sql`${fragments.embeddingLastAttemptAt} NULLS FIRST`)
    .limit(BATCH_LIMIT)

  let ok = 0
  let failed = 0

  for (const row of rows) {
    const vec = await embedText(row.content ?? '', {
      apiKey: config.apiKey,
      model: config.models.embedding,
    })
    if (vec) {
      await db
        .update(fragments)
        .set({
          embedding: vec,
          embeddingLastAttemptAt: new Date(),
        })
        .where(sql`${fragments.lookupKey} = ${row.lookupKey}`)
      ok++
    } else {
      const failure = takeLastEmbedFailure()
      log.warn(
        { lookupKey: row.lookupKey, attempt: row.attemptCount + 1, failure },
        'embedding retry failed'
      )
      await db
        .update(fragments)
        .set({
          embeddingAttemptCount: row.attemptCount + 1,
          embeddingLastAttemptAt: new Date(),
        })
        .where(sql`${fragments.lookupKey} = ${row.lookupKey}`)
      failed++
    }
  }

  const elapsed = Math.round(performance.now() - t0)
  log.info({ jobId: job.jobId, scanned: rows.length, ok, failed, ms: elapsed }, 'embedding retry batch done')

  return {
    jobId: job.jobId,
    success: true,
    processedAt: new Date().toISOString(),
  }
}
