CREATE TABLE IF NOT EXISTS "knowledge_audit_log" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_id" text NOT NULL,
  "action" text NOT NULL,
  "agent_id" text,
  "project_id" text,
  "session_id" text,
  "details" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "knowledge_audit_log_knowledge_idx"
  ON "knowledge_audit_log" ("knowledge_id");
CREATE INDEX IF NOT EXISTS "knowledge_audit_log_action_idx"
  ON "knowledge_audit_log" ("action");
CREATE INDEX IF NOT EXISTS "knowledge_audit_log_agent_idx"
  ON "knowledge_audit_log" ("agent_id");
CREATE INDEX IF NOT EXISTS "knowledge_audit_log_created_idx"
  ON "knowledge_audit_log" ("created_at");
CREATE INDEX IF NOT EXISTS "knowledge_audit_log_knowledge_action_idx"
  ON "knowledge_audit_log" ("knowledge_id", "action");
