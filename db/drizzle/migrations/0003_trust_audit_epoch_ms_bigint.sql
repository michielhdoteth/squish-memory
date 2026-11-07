-- Trust audit timestamps are epoch milliseconds (Date.now), which exceed
-- PostgreSQL's 32-bit INTEGER range. Widen without changing existing values.
ALTER TABLE trust_audit_log
  ALTER COLUMN created_at TYPE BIGINT
  USING created_at::BIGINT;
