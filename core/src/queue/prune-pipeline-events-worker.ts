import type { JobResult, PrunePipelineEventsJob } from '@robin/queue'
import { db } from '../db/client.js'
import { prunePipelineEvents } from '../db/pipeline-events.js'
import { emitAuditEvent } from '../db/audit.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'prune-pipeline-events' })

/**
 * Daily prune of pipeline_events. Defaults inside prunePipelineEvents trim
 * completed rows older than 30 days and failed rows older than 90 days — the
 * same retention rule that's been coded but uncalled until now.
 *
 * Emits an audit row regardless of how many rows were pruned so operators can
 * confirm the cron actually fires (RESEARCH §5: "ensure the recurring job
 * actually runs (add an audit row from the scheduler itself)").
 */
export async function processPrunePipelineEventsJob(
  job: PrunePipelineEventsJob
): Promise<JobResult> {
  log.info({ jobId: job.jobId }, 'pruning pipeline_events')
  const t0 = performance.now()

  try {
    const deleted = await prunePipelineEvents(db as never)
    const elapsed = Math.round(performance.now() - t0)
    log.info({ jobId: job.jobId, deleted, ms: elapsed }, 'prune-pipeline-events done')

    await emitAuditEvent(db, {
      entityType: 'pipeline_events',
      entityId: 'retention',
      eventType: 'pruned',
      source: 'system',
      summary: `Pruned ${deleted} pipeline_events row(s)`,
      detail: { jobId: job.jobId, deleted, durationMs: elapsed },
    })

    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ jobId: job.jobId, error: message }, 'prune-pipeline-events failed')
    await emitAuditEvent(db, {
      entityType: 'pipeline_events',
      entityId: 'retention',
      eventType: 'prune_failed',
      source: 'system',
      summary: `Prune failed: ${message}`,
      detail: { jobId: job.jobId, error: message },
    })
    throw err
  }
}
