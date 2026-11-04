-- 技术保留预览会按时间顺序定位历史运行日志；没有时间索引时，大库确认清理会长时间阻塞。
-- 每个索引只覆盖维护查询使用的时间列，既保证候选集和指纹稳定，也不触碰业务数据表。
CREATE INDEX IF NOT EXISTS idx_ozon_scheduler_trace_events_created_at
  ON ozon_scheduler_trace_events(created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_request_jobs_created_at
  ON ozon_request_jobs(created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_request_attempts_created_at
  ON ozon_request_attempts(created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_cache_merge_log_created_at
  ON ozon_cache_merge_log(created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_sync_locks_released_at
  ON ozon_sync_locks(released_at);

CREATE INDEX IF NOT EXISTS idx_ozon_sync_snapshots_finished_at
  ON ozon_sync_snapshots(finished_at);

PRAGMA user_version = 50;
