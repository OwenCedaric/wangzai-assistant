import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTraceController } from './traceController.js';

function createTraceDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ozon_scheduler_trace_events (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      request_id TEXT,
      attempt_id TEXT,
      snapshot_id TEXT,
      domain TEXT,
      shop_id TEXT,
      endpoint_key TEXT,
      batch_index INTEGER,
      batch_total INTEGER,
      priority TEXT,
      source TEXT,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      queue_wait_ms INTEGER,
      permit_wait_ms INTEGER,
      request_duration_ms INTEGER,
      merge_duration_ms INTEGER,
      retry_count INTEGER,
      retry_after_ms INTEGER,
      status_code INTEGER,
      ozon_code TEXT,
      error_message TEXT,
      source_file TEXT,
      source_function TEXT,
      source_line INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test('trace controller batches writes and preserves immediate diagnostic readback', () => {
  const db = createTraceDb();
  let scheduledFlush = null;
  try {
    const controller = createTraceController(db, {
      flushBatchSize: 10,
      setTimeoutImpl(callback) {
        scheduledFlush = callback;
        return { unref() {} };
      },
      clearTimeoutImpl() {
        scheduledFlush = null;
      },
    });
    controller.record({ id: 'trace-1', jobId: 'job-1', phase: 'created', status: 'queued' });
    controller.record({ id: 'trace-2', jobId: 'job-1', phase: 'running', status: 'running' });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_scheduler_trace_events').get().count, 0);
    assert.equal(controller.getStatus().bufferedEvents, 2);
    assert.equal(controller.listByJob('job-1').length, 2, 'diagnostic reads flush the current batch first');
    assert.equal(controller.getStatus().bufferedEvents, 0);
    assert.equal(scheduledFlush, null);
  } finally {
    db.close();
  }
});

test('trace controller commits a full batch in one bounded flush', () => {
  const db = createTraceDb();
  try {
    const controller = createTraceController(db, { flushBatchSize: 2 });
    controller.record({ id: 'trace-a', jobId: 'job-a', phase: 'created', status: 'queued' });
    controller.record({ id: 'trace-b', jobId: 'job-b', phase: 'created', status: 'queued' });
    assert.equal(db.prepare('SELECT COUNT(*) count FROM ozon_scheduler_trace_events').get().count, 2);
    assert.equal(controller.getStatus().bufferedEvents, 0);
    assert.equal(controller.close().written, 0);
  } finally {
    db.close();
  }
});
