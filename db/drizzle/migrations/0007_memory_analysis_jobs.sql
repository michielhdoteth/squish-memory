CREATE TABLE IF NOT EXISTS "memory_analysis_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_memory_id" uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "job_kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" bigint DEFAULT floor(extract(epoch from now()))::bigint NOT NULL,
  "locked_at" bigint,
  "last_error_code" text,
  "created_at" bigint DEFAULT floor(extract(epoch from now()))::bigint NOT NULL,
  "updated_at" bigint DEFAULT floor(extract(epoch from now()))::bigint NOT NULL,
  CONSTRAINT "memory_analysis_jobs_source_kind_uq" UNIQUE ("source_memory_id", "job_kind")
);

CREATE INDEX IF NOT EXISTS "memory_analysis_jobs_status_available_idx"
  ON "memory_analysis_jobs" ("status", "available_at");
CREATE INDEX IF NOT EXISTS "memory_analysis_jobs_project_idx"
  ON "memory_analysis_jobs" ("project_id");
