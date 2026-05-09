import { describe, it, expect, vi } from 'vitest'
import { recordJobRun } from './scheduled-jobs.js'
import { scheduledJobs } from '../db/schema.js'

// Unit tests for the scheduled-jobs heartbeat helper (issue #322).
//
// The helper is a thin INSERT ... ON CONFLICT (job_name) DO UPDATE wrapper,
// so the assertions are about the shape of the call chain (target table,
// conflict target, set-clause keys) rather than the SQL string. A real-DB
// integration test belongs in the worker test where this helper is wired
// into the prune-pipeline-events tick.

interface ChainCapture {
  values?: Record<string, unknown>
  conflictTarget?: unknown
  conflictSet?: Record<string, unknown>
  insertedTable?: unknown
}

function makeFakeDb(capture: ChainCapture) {
  const builder = {
    values(values: Record<string, unknown>) {
      capture.values = values
      return builder
    },
    onConflictDoUpdate(args: { target: unknown; set: Record<string, unknown> }) {
      capture.conflictTarget = args.target
      capture.conflictSet = args.set
      return Promise.resolve()
    },
  }
  return {
    insert(table: unknown) {
      capture.insertedTable = table
      return builder
    },
  }
}

describe('recordJobRun', () => {
  it('targets the scheduled_jobs table with the expected insert payload', async () => {
    const capture: ChainCapture = {}
    const fake = makeFakeDb(capture)

    await recordJobRun(
      fake as never,
      'prune_pipeline_events',
      'completed',
      { deleted: 42, jobId: 'tick-1' },
      125
    )

    expect(capture.insertedTable).toBe(scheduledJobs)
    expect(capture.values?.jobName).toBe('prune_pipeline_events')
    expect(capture.values?.lastRunStatus).toBe('completed')
    expect(capture.values?.lastRunMeta).toEqual({ deleted: 42, jobId: 'tick-1' })
    expect(capture.values?.lastRunDurationMs).toBe(125)
    expect(capture.values?.lastRunAt).toBeInstanceOf(Date)
  })

  it('upserts on the job_name primary key with status, meta, and duration in the set clause', async () => {
    const capture: ChainCapture = {}
    const fake = makeFakeDb(capture)

    await recordJobRun(
      fake as never,
      'prune_pipeline_events',
      'partial',
      { deleted: 0, error: 'lock contention' },
      900
    )

    // The DO UPDATE must overwrite the same row, keyed on job_name.
    expect(capture.conflictTarget).toBe(scheduledJobs.jobName)
    expect(capture.conflictSet).toBeDefined()
    const setKeys = Object.keys(capture.conflictSet ?? {}).sort()
    expect(setKeys).toEqual(
      ['lastRunAt', 'lastRunDurationMs', 'lastRunMeta', 'lastRunStatus'].sort()
    )
    expect(capture.conflictSet?.lastRunStatus).toBe('partial')
    expect(capture.conflictSet?.lastRunMeta).toEqual({ deleted: 0, error: 'lock contention' })
    expect(capture.conflictSet?.lastRunDurationMs).toBe(900)
  })

  it('propagates failed status and error meta through the set clause', async () => {
    const capture: ChainCapture = {}
    const fake = makeFakeDb(capture)

    await recordJobRun(
      fake as never,
      'prune_pipeline_events',
      'failed',
      { error: 'connection refused' },
      12
    )

    expect(capture.values?.lastRunStatus).toBe('failed')
    expect(capture.conflictSet?.lastRunStatus).toBe('failed')
    expect(capture.values?.lastRunMeta).toEqual({ error: 'connection refused' })
  })

  it('returns void on a vanilla insert (no conflict path needed)', async () => {
    // Even on a fresh row the helper still issues onConflictDoUpdate so the
    // call shape is identical for first run and subsequent runs. This locks
    // that contract.
    const capture: ChainCapture = {}
    const fake = makeFakeDb(capture)

    const result = await recordJobRun(fake as never, 'prune_pipeline_events', 'completed', {}, 1)
    expect(result).toBeUndefined()
    expect(capture.conflictTarget).toBe(scheduledJobs.jobName)
  })

  it('forwards the call once per invocation', async () => {
    const insertSpy = vi.fn().mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    })
    const fake = { insert: insertSpy }

    await recordJobRun(fake as never, 'prune_pipeline_events', 'completed', {}, 0)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith(scheduledJobs)
  })
})
