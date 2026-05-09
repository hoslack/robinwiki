/**
 * Canonical surface for daily and periodic job heartbeats (issue #322).
 *
 * Every scheduled worker (the daily prune-pipeline-events job, future
 * HyDE backfill, fragment-relationship backfill, and so on) calls
 * recordJobRun at the end of each tick instead of writing to audit_log.
 * audit_log is reserved for user-visible state changes; scheduled_jobs
 * captures worker telemetry. Keeping the two surfaces separate keeps
 * operator audits readable.
 *
 * The function is an INSERT plus ON CONFLICT (job_name) DO UPDATE so a
 * job's row is created on its first run and overwritten on every
 * subsequent run. Each row tracks only the latest tick by design (the
 * goal is "did this job run today" not a full history). If a future
 * caller needs history, that should land as a separate event log.
 */

import { sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { scheduledJobs } from '../db/schema.js'

export type ScheduledJobStatus = 'completed' | 'failed' | 'partial'

export async function recordJobRun(
  db: DB,
  jobName: string,
  status: ScheduledJobStatus,
  meta: Record<string, unknown>,
  durationMs: number
): Promise<void> {
  await db
    .insert(scheduledJobs)
    .values({
      jobName,
      lastRunAt: new Date(),
      lastRunStatus: status,
      lastRunMeta: meta,
      lastRunDurationMs: durationMs,
    })
    .onConflictDoUpdate({
      target: scheduledJobs.jobName,
      set: {
        lastRunAt: sql`now()`,
        lastRunStatus: status,
        lastRunMeta: meta,
        lastRunDurationMs: durationMs,
      },
    })
}
