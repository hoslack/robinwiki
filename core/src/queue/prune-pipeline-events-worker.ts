import type { JobResult, PrunePipelineEventsJob } from '@robin/queue'
import { db } from '../db/client.js'
import { prunePipelineEvents } from '../db/pipeline-events.js'
import { recordJobRun } from '../lib/scheduled-jobs.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'prune-pipeline-events' })

const JOB_NAME = 'prune_pipeline_events'

/**
 * Daily prune of pipeline_events. Defaults inside prunePipelineEvents trim
 * completed rows older than 30 days and failed rows older than 90 days, the
 * same retention rule that's been coded but uncalled until now.
 *
 * Records a heartbeat in scheduled_jobs after every run (issue #322) so
 * operators can confirm the cron actually fires. The previous pattern
 * wrote into audit_log; that table is reserved for user-visible state
 * changes, so the heartbeat moved here.
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

    await recordJobRun(
      db,
      JOB_NAME,
      'completed',
      { jobId: job.jobId, deleted },
      elapsed
    )

    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const elapsed = Math.round(performance.now() - t0)
    log.error({ jobId: job.jobId, error: message }, 'prune-pipeline-events failed')
    await recordJobRun(
      db,
      JOB_NAME,
      'failed',
      { jobId: job.jobId, error: message },
      elapsed
    )
    throw err
  }
}
