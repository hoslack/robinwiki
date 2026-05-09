import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrunePipelineEventsJob } from '@robin/queue'

// ── Mocks ───────────────────────────────────────────────────────────────
//
// Issue #322: the daily prune-events tick now writes its heartbeat into
// scheduled_jobs via recordJobRun, not into audit_log via emitAuditEvent.
// These tests pin both halves of the move:
//   - happy path records 'completed' on scheduled_jobs with deleted count
//   - failure path records 'failed' on scheduled_jobs with error meta
//   - audit_log emit is never called (the old surface stays untouched)

const mockPrunePipelineEvents = vi.fn()
const mockRecordJobRun = vi.fn().mockResolvedValue(undefined)
const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/client.js', () => ({
  db: {} as unknown,
}))

vi.mock('../db/pipeline-events.js', () => ({
  prunePipelineEvents: (...args: unknown[]) => mockPrunePipelineEvents(...args),
}))

vi.mock('../lib/scheduled-jobs.js', () => ({
  recordJobRun: (...args: unknown[]) => mockRecordJobRun(...args),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

// ── Import under test (after mocks) ────────────────────────────────────

const { processPrunePipelineEventsJob } = await import(
  '../queue/prune-pipeline-events-worker.js'
)

// ── Helpers ─────────────────────────────────────────────────────────────

function makeJob(jobId = 'prune-tick-1'): PrunePipelineEventsJob {
  return {
    type: 'prune-pipeline-events',
    jobId,
    triggeredBy: 'scheduler',
    enqueuedAt: new Date().toISOString(),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('processPrunePipelineEventsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records a completed heartbeat in scheduled_jobs with the deleted count', async () => {
    mockPrunePipelineEvents.mockResolvedValueOnce(7)
    const job = makeJob('tick-completed')

    const result = await processPrunePipelineEventsJob(job)

    expect(result.success).toBe(true)
    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    const [, jobName, status, meta, durationMs] = mockRecordJobRun.mock.calls[0]
    expect(jobName).toBe('prune_pipeline_events')
    expect(status).toBe('completed')
    expect(meta).toEqual({ jobId: 'tick-completed', deleted: 7 })
    expect(typeof durationMs).toBe('number')
    expect(durationMs).toBeGreaterThanOrEqual(0)
  })

  it('does not write to audit_log on the happy path', async () => {
    mockPrunePipelineEvents.mockResolvedValueOnce(0)
    await processPrunePipelineEventsJob(makeJob('tick-no-rows'))

    expect(mockEmitAuditEvent).not.toHaveBeenCalled()
  })

  it('records a failed heartbeat and rethrows when prune fails', async () => {
    mockPrunePipelineEvents.mockRejectedValueOnce(new Error('boom'))
    const job = makeJob('tick-failed')

    await expect(processPrunePipelineEventsJob(job)).rejects.toThrow('boom')

    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    const [, jobName, status, meta] = mockRecordJobRun.mock.calls[0]
    expect(jobName).toBe('prune_pipeline_events')
    expect(status).toBe('failed')
    expect(meta).toEqual({ jobId: 'tick-failed', error: 'boom' })
  })

  it('does not write to audit_log even on failure', async () => {
    mockPrunePipelineEvents.mockRejectedValueOnce(new Error('boom2'))
    await expect(processPrunePipelineEventsJob(makeJob('tick-failed-2'))).rejects.toThrow()

    expect(mockEmitAuditEvent).not.toHaveBeenCalled()
  })

  it('uses the canonical job_name "prune_pipeline_events" so the row stays singular', async () => {
    mockPrunePipelineEvents.mockResolvedValueOnce(3)
    await processPrunePipelineEventsJob(makeJob('tick-name-check'))

    // Locks the helper key so future calls keep upserting the same row
    // rather than fanning out into per-tick rows.
    expect(mockRecordJobRun.mock.calls[0][1]).toBe('prune_pipeline_events')
  })
})
